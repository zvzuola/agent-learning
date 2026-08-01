import { randomUUID } from 'node:crypto';

import { InMemoryCheckpointStore } from '../state/in-memory-checkpoint-store.js';
import { createEvent, NullEventSink } from '../observability/events.js';

/**
 * Agent Runtime backed by the official Anthropic SDK.
 *
 * It intentionally delegates HTTP, authentication, retries at the SDK
 * transport and response typing to @anthropic-ai/sdk. Its ownership is the
 * Agent layer: state, tool execution, budgets and events.
 */
export class CodingAgent {
  /**
   * @param {object} dependencies
   * @param {{messages: {create(params: object, options?: object): Promise<AnthropicMessage>}}} dependencies.client
   * @param {import('../tools/tool-registry.js').ToolRegistry} dependencies.tools
   * @param {{model: string, maxTokens: number, system?: string, maxSteps?: number, maxToolCalls?: number}} dependencies.config
   * @param {import('../observability/events.js').InMemoryEventSink | import('../observability/events.js').NullEventSink} [dependencies.eventSink]
   * @param {InMemoryCheckpointStore} [dependencies.checkpointStore]
   */
  constructor({
    client,
    tools,
    config,
    eventSink = new NullEventSink(),
    checkpointStore = new InMemoryCheckpointStore(),
  }) {
    if (!client?.messages?.create) {
      throw new TypeError('client.messages.create is required');
    }
    if (!config?.model) {
      throw new TypeError('config.model is required');
    }
    if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1) {
      throw new RangeError('config.maxTokens must be a positive integer');
    }

    const maxSteps = config.maxSteps ?? 8;
    const maxToolCalls = config.maxToolCalls ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError('config.maxSteps must be a positive integer');
    }
    if (maxToolCalls !== Number.POSITIVE_INFINITY
      && (!Number.isInteger(maxToolCalls) || maxToolCalls < 1)) {
      throw new RangeError('config.maxToolCalls must be a positive integer');
    }

    this.client = client;
    this.tools = tools;
    this.config = {
      system: config.system ?? '',
      model: config.model,
      maxTokens: config.maxTokens,
      maxSteps,
      maxToolCalls,
    };
    this.eventSink = eventSink;
    this.checkpointStore = checkpointStore;
  }

  /**
   * Run one user turn while preserving the model state needed for subsequent
   * decisions and tool results.
   *
   * @param {string} input
   * @param {{messages?: import('@anthropic-ai/sdk/resources/messages').MessageParam[], runId?: string, signal?: AbortSignal}} [options]
   */
  async run(input, options = {}) {
    const runId = options.runId ?? randomUUID();
    const messages = structuredClone(options.messages ?? []);
    messages.push({ role: 'user', content: input });
    let toolCalls = 0;
    let lastResponse = null;

    await this.#emit(createEvent(runId, 0, 'run.started', { input }));

    for (let step = 1; step <= this.config.maxSteps; step += 1) {
      try {
        lastResponse = await this.client.messages.create(
          {
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            ...(this.config.system ? { system: this.config.system } : {}),
            messages,
            tools: this.tools.definitions(),
          },
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch (error) {
        const message = formatError(error);
        await this.#emit(createEvent(runId, step, 'run.failed', {
          reason: 'model_error',
          error: message,
        }));
        return makeResult(runId, 'model_error', messages, step, null, message);
      }

      if (!Array.isArray(lastResponse?.content) || !lastResponse.stop_reason) {
        const error = 'Model SDK returned an invalid response';
        await this.#emit(createEvent(runId, step, 'run.failed', {
          reason: 'invalid_response',
          error,
        }));
        return makeResult(runId, 'invalid_response', messages, step, null, error);
      }

      const toolUses = lastResponse.content.filter((block) => block.type === 'tool_use');
      await this.#emit(createEvent(runId, step, 'model.completed', {
        stopReason: lastResponse.stop_reason,
        toolCalls: toolUses.length,
        inputTokens: lastResponse.usage?.input_tokens ?? null,
        outputTokens: lastResponse.usage?.output_tokens ?? null,
      }));

      if (lastResponse.stop_reason === 'tool_use' && toolUses.length > 0) {
        if (toolCalls + toolUses.length > this.config.maxToolCalls) {
          const error = 'Maximum tool-call budget exhausted';
          await this.#emit(createEvent(runId, step, 'run.stopped', {
            reason: 'max_tool_calls',
          }));
          return makeResult(runId, 'max_tool_calls', messages, step, lastResponse, error);
        }

        messages.push({ role: 'assistant', content: structuredClone(lastResponse.content) });
        const results = await Promise.all(toolUses.map(async (toolUse) => {
          const result = await this.tools.execute({
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });
          toolCalls += 1;
          await this.#emit(createEvent(runId, step, 'tool.completed', {
            name: toolUse.name,
            toolUseId: toolUse.id,
            isError: result.is_error === true,
          }));
          return result;
        }));
        messages.push({ role: 'user', content: results });
        continue;
      }

      messages.push({ role: 'assistant', content: structuredClone(lastResponse.content) });

      if (lastResponse.stop_reason === 'end_turn' || lastResponse.stop_reason === 'stop_sequence') {
        await this.#emit(createEvent(runId, step, 'run.completed', {
          stopReason: lastResponse.stop_reason,
        }));
        return makeResult(runId, 'completed', messages, step, lastResponse);
      }

      await this.#emit(createEvent(runId, step, 'run.stopped', {
        reason: lastResponse.stop_reason ?? 'unknown',
      }));
      return makeResult(runId, lastResponse.stop_reason ?? 'stopped', messages, step, lastResponse);
    }

    await this.#emit(createEvent(runId, this.config.maxSteps, 'run.stopped', {
      reason: 'max_steps',
    }));
    return makeResult(runId, 'max_steps', messages, this.config.maxSteps, lastResponse);
  }

  /**
   * Run a turn against a checkpointed thread. The checkpoint adapter owns
   * persistence; the Agent remains unaware of the storage implementation.
   *
   * @param {string} threadId
   * @param {string} input
   * @param {{signal?: AbortSignal}} [options]
   */
  async runThread(threadId, input, { signal } = {}) {
    if (!threadId) throw new TypeError('threadId is required');
    const messages = await this.checkpointStore.load(threadId);
    const result = await this.run(input, { messages, signal });
    if (result.status !== 'model_error') {
      await this.checkpointStore.save(threadId, result.messages);
    }
    return result;
  }

  /** @param {import('../observability/events.js').AgentEvent} event */
  async #emit(event) {
    try {
      await this.eventSink.emit(event);
    } catch {
      // Observability failure must not break an in-flight Agent run.
    }
  }
}

function makeResult(runId, status, messages, steps, response = null, error = null) {
  return {
    runId,
    status,
    messages: structuredClone(messages),
    steps,
    response,
    error,
    text: response ? response.content.filter((block) => block.type === 'text').map((block) => block.text).join('') : '',
  };
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
