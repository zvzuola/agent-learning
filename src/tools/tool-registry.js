import { createHash } from 'node:crypto';

import { InMemoryIdempotencyStore } from './in-memory-idempotency-store.js';
import { ToolPolicy } from './tool-policy.js';

/**
 * A client-side business tool exposed to the Agent.
 *
 * The API only knows the JSON schema. The application owns validation,
 * execution policy and the handler that may perform side effects.
 */
export class ToolRegistry {
  /**
   * @param {object} [options]
   * @param {ToolPolicy | ConstructorParameters<typeof ToolPolicy>[0]} [options.policy]
   * @param {{claim(key: string, fingerprint: string): unknown, complete(key: string, token: string, result: unknown): unknown, release(key: string, token: string): unknown}} [options.idempotencyStore]
   */
  constructor({ policy = new ToolPolicy(), idempotencyStore } = {}) {
    /** @type {Map<string, ToolDefinition>} */
    this.tools = new Map();
    this.policy = policy instanceof ToolPolicy ? policy : new ToolPolicy(policy);
    this.idempotencyStore = idempotencyStore ?? new InMemoryIdempotencyStore();
    if (typeof this.idempotencyStore.claim !== 'function'
      || typeof this.idempotencyStore.complete !== 'function'
      || typeof this.idempotencyStore.release !== 'function') {
      throw new TypeError('idempotencyStore must implement claim, complete and release');
    }
    this.inFlight = new Map();
  }

  /** @param {ToolDefinition} tool */
  register(tool) {
    validateToolDefinition(tool);
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.policy.resolve(tool);
    this.tools.set(tool.name, tool);
    return this;
  }

  /** @returns {import('@anthropic-ai/sdk/resources/messages').Tool[]} */
  definitions() {
    return [...this.tools.values()]
      .filter((tool) => this.policy.resolve(tool).allowed)
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        input_schema: structuredClone(inputSchema),
      }));
  }

  /**
   * Execute one model-requested tool. Every expected failure is converted into
   * a classified model observation so the Agent can recover or explain it.
   *
   * @param {{id: string, name: string, input: unknown}} call
   * @param {{signal?: AbortSignal, runId?: string, idempotencyKey?: string}} [context]
   */
  async execute(call, context = {}) {
    const startedAt = Date.now();
    const tool = this.tools.get(call.name);
    if (!tool) {
      return toolError(call, {
        code: 'tool_not_found',
        message: `Unknown tool: ${call.name}`,
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    const policy = this.policy.resolve(tool);
    if (!policy.allowed) {
      return toolError(call, {
        code: 'policy_denied',
        message: `Tool execution denied by policy: ${call.name}`,
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    let input;
    try {
      input = tool.validate ? await tool.validate(call.input) : call.input;
    } catch (error) {
      return toolError(call, {
        code: 'validation_error',
        message: formatError(error),
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    let selectedKey = null;
    if (policy.idempotency !== 'none') {
      try {
        const contextKey = nonEmpty(context.idempotencyKey);
        const extractedKey = nonEmpty(await tool.idempotencyKey?.(input));
        if (contextKey && extractedKey && contextKey !== extractedKey) {
          return toolError(call, {
            code: 'idempotency_key_mismatch',
            message: `Provided idempotency keys do not match: ${call.name}`,
            retryable: false,
            durationMs: Date.now() - startedAt,
          });
        }
        selectedKey = extractedKey
          ?? contextKey
          ?? (policy.idempotency === 'cache' ? createImplicitKey(call.name, input) : null);
      } catch (error) {
        return toolError(call, {
          code: 'idempotency_key_error',
          message: 'Unable to resolve the tool idempotency key',
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }
    }
    const idempotencyKey = selectedKey;
    if (policy.idempotency === 'required' && !idempotencyKey) {
      return toolError(call, {
        code: 'idempotency_key_required',
        message: `Tool requires an idempotency key: ${call.name}`,
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    if (idempotencyKey) {
      let cacheKey;
      let fingerprint;
      try {
        cacheKey = createStorageKey(call.name, idempotencyKey);
        fingerprint = createInputFingerprint(input);
      } catch (error) {
        void error;
        return toolError(call, {
          code: 'idempotency_key_error',
          message: 'Unable to fingerprint the validated tool input',
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }
      let claim;
      try {
        claim = await this.idempotencyStore.claim(cacheKey, fingerprint);
      } catch (error) {
        void error;
        return toolError(call, {
          code: 'idempotency_store_read_error',
          message: 'Unable to read the idempotency store before tool execution',
          retryable: true,
          durationMs: Date.now() - startedAt,
        });
      }
      if (!claim || typeof claim.status !== 'string') {
        return toolError(call, {
          code: 'idempotency_store_read_error',
          message: 'The idempotency store returned an invalid claim result',
          retryable: true,
          durationMs: Date.now() - startedAt,
        });
      }
      if (claim.status === 'replay') {
        try {
          return replayResult(call.id, claim.result, Date.now() - startedAt);
        } catch (error) {
          void error;
          return toolError(call, {
            code: 'idempotency_store_read_error',
            message: 'The stored idempotency result is invalid',
            retryable: false,
            durationMs: Date.now() - startedAt,
          });
        }
      }
      if (claim.status === 'conflict') {
        return toolError(call, {
          code: 'idempotency_conflict',
          message: `Idempotency key was already used with different input: ${call.name}`,
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }
      if (claim.status === 'capacity_exhausted') {
        return toolError(call, {
          code: 'idempotency_store_capacity_exhausted',
          message: 'The idempotency store has no capacity for a new operation',
          retryable: true,
          durationMs: Date.now() - startedAt,
        });
      }

      if (claim.status === 'in_progress') {
        const active = this.inFlight.get(cacheKey);
        if (!active) {
          return toolError(call, {
            code: 'idempotency_in_progress',
            message: `The same operation is already running: ${call.name}`,
            retryable: true,
            durationMs: Date.now() - startedAt,
          });
        }
        try {
          const outcome = context.signal
            ? await raceWithSignal(active.result, context.signal)
            : await active.result;
          return replayResult(call.id, outcome, Date.now() - startedAt);
        } catch (error) {
          const classified = classifyError(error, {
            timedOut: false,
            callerAborted: context.signal?.aborted === true,
          });
          return toolError(call, {
            ...classified,
            durationMs: Date.now() - startedAt,
          });
        }
      }
      if (claim.status !== 'claimed' || typeof claim.token !== 'string') {
        return toolError(call, {
          code: 'idempotency_store_read_error',
          message: 'The idempotency store returned an unsupported claim state',
          retryable: true,
          durationMs: Date.now() - startedAt,
        });
      }

      const execution = this.#execute(
        tool,
        call,
        input,
        { ...context, idempotencyKey },
        policy,
        startedAt,
      );
      this.inFlight.set(cacheKey, { fingerprint, result: execution });
      try {
        const outcome = await execution;
        if (shouldReleaseIdempotencyClaim(outcome)) {
          try {
            await this.idempotencyStore.release(cacheKey, claim.token);
          } catch (error) {
            void error;
            return toolError(call, {
              code: 'idempotency_store_release_error',
              message: 'The failed tool attempt could not release its idempotency claim',
              retryable: false,
              durationMs: Date.now() - startedAt,
            });
          }
          return outcome;
        }

        try {
          await this.idempotencyStore.complete(cacheKey, claim.token, outcome);
        } catch (error) {
          void error;
          return toolError(call, {
            code: 'idempotency_store_write_error',
            message: 'The tool finished, but its idempotency result could not be stored',
            retryable: false,
            durationMs: Date.now() - startedAt,
          });
        }
        return outcome;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    }

    return this.#execute(tool, call, input, context, policy, startedAt);
  }

  async #execute(tool, call, input, context, policy, startedAt) {
    const timeoutController = new AbortController();
    const combinedSignal = combineSignals([context.signal, timeoutController.signal]);
    const timeoutReason = new ToolTimeoutError(call.name, policy.timeoutMs);
    let timer;

    if (policy.timeoutMs !== null) {
      timer = setTimeout(() => timeoutController.abort(timeoutReason), policy.timeoutMs);
    }

    try {
      if (combinedSignal.aborted) throw combinedSignal.reason;
      const value = await raceWithSignal(
        tool.handler(input, {
          idempotencyKey: context.idempotencyKey,
          signal: combinedSignal,
          runId: context.runId,
          toolUseId: call.id,
        }),
        combinedSignal,
      );
      let content;
      try {
        content = JSON.stringify(value ?? null);
        if (content === undefined) throw new TypeError('Tool result is not JSON serializable');
      } catch (error) {
        void error;
        return toolError(call, {
          code: 'result_serialization_error',
          message: 'Tool result is not JSON serializable',
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }
      const resultBytes = Buffer.byteLength(content, 'utf8');
      if (policy.maxResultBytes !== null && resultBytes > policy.maxResultBytes) {
        return toolError(call, {
          code: 'result_too_large',
          message: `Tool result exceeds the ${policy.maxResultBytes}-byte limit`,
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }
      return toolSuccess(call, content, Date.now() - startedAt);
    } catch (error) {
      const classified = classifyError(error, {
        timedOut: timeoutController.signal.aborted,
        callerAborted: context.signal?.aborted === true,
      });
      return toolError(call, {
        ...classified,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(timer);
    }
  }

}

/**
 * Expected tool failures can use this type to provide a stable machine code
 * without exposing implementation-specific exception text as the contract.
 */
export class ToolExecutionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, cause?: unknown}} [options]
   */
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ToolExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class ToolTimeoutError extends ToolExecutionError {
  constructor(toolName, timeoutMs) {
    super(
      'timeout',
      `Tool timed out after ${timeoutMs} ms: ${toolName}`,
      { retryable: true },
    );
    this.name = 'ToolTimeoutError';
  }
}

/**
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema
 * @property {(input: unknown) => unknown | Promise<unknown>} [validate]
 * @property {(input: any, context: ToolExecutionContext) => unknown | Promise<unknown>} handler
 * @property {{allow?: boolean, timeoutMs?: number|null, maxResultBytes?: number|null, idempotency?: 'none'|'optional'|'required'|'cache'}} [policy]
 * @property {(input: any) => string | null | undefined | Promise<string | null | undefined>} [idempotencyKey]
 */

/**
 * @typedef {object} ToolExecutionContext
 * @property {string | undefined} idempotencyKey
 * @property {AbortSignal} signal
 * @property {string | undefined} runId
 * @property {string} toolUseId
 */

/** @param {ToolDefinition} tool */
function validateToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('tool definition must be an object');
  }
  if (typeof tool.name !== 'string' || !tool.name) {
    throw new TypeError('tool.name is required');
  }
  if (typeof tool.description !== 'string' || !tool.description) {
    throw new TypeError(`tool.description is required: ${tool.name}`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
    throw new TypeError(`tool.inputSchema is required: ${tool.name}`);
  }
  if (typeof tool.handler !== 'function') {
    throw new TypeError(`tool.handler is required: ${tool.name}`);
  }
  if (tool.validate !== undefined && typeof tool.validate !== 'function') {
    throw new TypeError(`tool.validate must be a function: ${tool.name}`);
  }
  if (tool.idempotencyKey !== undefined && typeof tool.idempotencyKey !== 'function') {
    throw new TypeError(`tool.idempotencyKey must be a function: ${tool.name}`);
  }
}

function toolSuccess(call, content, durationMs) {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    metadata: {
      tool: call.name,
      outcome: 'success',
      durationMs,
      replayed: false,
    },
  };
}

function toolError(call, { code, message, retryable, durationMs }) {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    is_error: true,
    content: JSON.stringify({
      tool: call.name,
      error: {
        code,
        message,
        retryable,
      },
    }),
    metadata: {
      tool: call.name,
      outcome: 'error',
      errorCode: code,
      retryable,
      durationMs,
      replayed: false,
    },
  };
}

function replayResult(toolUseId, result, durationMs) {
  const replayed = structuredClone(result);
  replayed.tool_use_id = toolUseId;
  replayed.metadata = {
    ...replayed.metadata,
    durationMs,
    replayed: true,
  };
  return replayed;
}

function shouldReleaseIdempotencyClaim(result) {
  return result.is_error === true && result.metadata?.retryable === true;
}

function classifyError(error, { timedOut, callerAborted }) {
  if (timedOut) {
    return {
      code: 'timeout',
      message: formatError(error),
      retryable: true,
    };
  }
  if (callerAborted || isAbortError(error)) {
    return {
      code: 'cancelled',
      message: 'Tool execution was cancelled',
      retryable: false,
    };
  }
  if (error instanceof ToolExecutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'execution_error',
    message: 'Tool execution failed',
    retryable: false,
  };
}

function combineSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return new AbortController().signal;
  return AbortSignal.any(activeSignals);
}

function raceWithSignal(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function createImplicitKey(name, input) {
  return createHash('sha256').update(`${name}:${stableStringify(input)}`).digest('hex');
}

function createStorageKey(name, idempotencyKey) {
  return createHash('sha256')
    .update(name)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
}

function createInputFingerprint(input) {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value)) ?? 'undefined';
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** @param {unknown} error */
function formatError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error === undefined) return 'Error: Tool execution failed';
  return String(error);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
