import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodingAgent,
  createReadProjectFileTool,
  InMemoryCheckpointStore,
  InMemoryEventSink,
  ToolRegistry,
} from '../../src/index.js';
import { FakeAnthropicClient, message } from '../../test-utils/model/fake-anthropic-client.js';

function setup(responses, overrides = {}) {
  const fileReads = [];
  const projectReader = {
    async readTextFile(filePath) {
      fileReads.push(filePath);
      return JSON.stringify({ name: 'demo-project', type: 'module' });
    },
  };
  const tools = new ToolRegistry();
  tools.register(createReadProjectFileTool(projectReader));
  const client = new FakeAnthropicClient(responses);
  const events = new InMemoryEventSink();
  const checkpointStore = new InMemoryCheckpointStore();
  const agent = new CodingAgent({
    client,
    tools,
    eventSink: events,
    checkpointStore,
    config: {
      model: 'claude-test',
      maxTokens: 512,
      maxSteps: 4,
      maxToolCalls: 4,
      system: 'You are a software development engineer. Inspect files before making claims.',
      ...overrides,
    },
  });
  return { agent, client, events, fileReads, checkpointStore };
}

test('sends a model request and returns the final text', async () => {
  const { agent, client } = setup([
    message({ content: [{ type: 'text', text: 'Hello.' }] }),
  ]);

  const result = await agent.run('Hi');

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello.');
  assert.deepEqual(client.calls[0].params.messages, [{ role: 'user', content: 'Hi' }]);
  assert.equal(
    client.calls[0].params.system,
    'You are a software development engineer. Inspect files before making claims.',
  );
  assert.equal(client.calls[0].params.max_tokens, 512);
  assert.equal(client.calls[0].params.model, 'claude-test');
  assert.equal(client.calls[0].params.tools[0].name, 'read_project_file');
});

test('executes a requested tool and returns its result before the next decision', async () => {
  const firstContent = [
    { type: 'text', text: 'I will inspect the project manifest.' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_project_file', input: { path: 'package.json' } },
  ];
  const { agent, client, fileReads, events } = setup([
    message({ content: firstContent, stopReason: 'tool_use' }),
    message({ content: [{ type: 'text', text: 'This is an ESM Node.js project.' }] }),
  ]);

  const result = await agent.run('Inspect package.json');

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2);
  assert.deepEqual(fileReads, ['package.json']);
  const secondMessages = client.calls[1].params.messages;
  assert.deepEqual(secondMessages[1], { role: 'assistant', content: firstContent });
  assert.equal(secondMessages[2].role, 'user');
  assert.equal(secondMessages[2].content[0].type, 'tool_result');
  assert.equal(secondMessages[2].content[0].tool_use_id, 'toolu_1');
  assert.match(secondMessages[2].content[0].content, /demo-project/);
  assert.deepEqual(events.events.map(({ name }) => name), [
    'run.started',
    'model.started',
    'model.completed',
    'tool.completed',
    'model.started',
    'model.completed',
    'run.completed',
  ]);
});

test('emits the complete model input and output for every decision step', async () => {
  const firstContent = [
    { type: 'tool_use', id: 'toolu_log', name: 'read_project_file', input: { path: 'package.json' } },
  ];
  const finalResponse = message({ content: [{ type: 'text', text: 'Done.' }] });
  const { agent, events } = setup([
    message({ content: firstContent, stopReason: 'tool_use' }),
    finalResponse,
  ]);

  await agent.run('Inspect the project');

  const modelStarted = events.events.filter(({ name }) => name === 'model.started');
  const modelCompleted = events.events.filter(({ name }) => name === 'model.completed');
  assert.equal(modelStarted.length, 2);
  assert.equal(modelCompleted.length, 2);
  assert.deepEqual(modelStarted[0].payload.input.messages, [
    { role: 'user', content: 'Inspect the project' },
  ]);
  assert.equal(modelStarted[0].payload.input.model, 'claude-test');
  assert.equal(modelStarted[0].payload.input.tools[0].name, 'read_project_file');
  assert.equal(modelStarted[1].payload.input.messages.at(-1).content[0].type, 'tool_result');
  assert.deepEqual(modelCompleted[0].payload.output.content, firstContent);
  assert.deepEqual(modelCompleted[1].payload.output, finalResponse);
});

test('returns validation failure to the model without calling the dependency', async () => {
  const { agent, client, fileReads } = setup([
    message({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'bad_1', name: 'read_project_file', input: { path: '' } }],
    }),
    message({ content: [{ type: 'text', text: 'A valid project path is required.' }] }),
  ]);

  const result = await agent.run('Read an invalid path');

  assert.equal(result.status, 'completed');
  assert.deepEqual(fileReads, []);
  const toolResult = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /ZodError/);
});

test('rejects tool input fields not declared by the public schema', async () => {
  const { agent, client, fileReads } = setup([
    message({
      stopReason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'extra_1',
        name: 'read_project_file',
        input: { path: 'package.json', unexpected: true },
      }],
    }),
    message({ content: [{ type: 'text', text: 'The extra field is not allowed.' }] }),
  ]);

  const result = await agent.run('Read with an extra field');

  assert.equal(result.status, 'completed');
  assert.deepEqual(fileReads, []);
  const toolResult = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /unrecognized_keys/);
});

test('does not execute tools after the tool-call budget is exhausted', async () => {
  const { agent, fileReads } = setup([
    message({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'read_project_file', input: { path: 'package.json' } },
        { type: 'tool_use', id: 'b', name: 'read_project_file', input: { path: 'README.md' } },
      ],
    }),
  ], { maxToolCalls: 1 });

  const result = await agent.run('Read two project files');

  assert.equal(result.status, 'max_tool_calls');
  assert.deepEqual(fileReads, []);
  assert.deepEqual(result.messages, [{ role: 'user', content: 'Read two project files' }]);
});

test('rejects fractional runtime budgets', () => {
  assert.throws(
    () => setup([], { maxSteps: 1.5 }),
    /maxSteps must be a positive integer/,
  );
  assert.throws(
    () => setup([], { maxToolCalls: 0.5 }),
    /maxToolCalls must be a positive integer/,
  );
});

test('does not persist malformed SDK responses', async () => {
  const malformedResponse = { content: 'not-blocks', stop_reason: null };
  const { agent, checkpointStore, events } = setup([malformedResponse]);

  const result = await agent.runThread('thread-invalid', 'Hi');

  assert.equal(result.status, 'invalid_response');
  assert.deepEqual(await checkpointStore.load('thread-invalid'), []);
  assert.deepEqual(events.events.map(({ name }) => name), [
    'run.started',
    'model.started',
    'model.completed',
    'run.failed',
  ]);
  assert.deepEqual(events.events[2].payload.output, malformedResponse);
});

test('does not checkpoint a turn stopped by a runtime budget', async () => {
  const { agent, checkpointStore } = setup([
    message({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'read_project_file', input: { path: 'package.json' } },
        { type: 'tool_use', id: 'b', name: 'read_project_file', input: { path: 'README.md' } },
      ],
    }),
  ], { maxToolCalls: 1 });

  const result = await agent.runThread('thread-budget', 'Inspect forever');

  assert.equal(result.status, 'max_tool_calls');
  assert.deepEqual(await checkpointStore.load('thread-budget'), []);
});

test('exposes non-success stop reasons instead of pretending completion', async () => {
  const { agent } = setup([
    message({ content: [{ type: 'text', text: 'Partial answer' }], stopReason: 'max_tokens' }),
  ]);

  const result = await agent.run('Long task');

  assert.equal(result.status, 'max_tokens');
  assert.equal(result.text, 'Partial answer');
});

test('returns an explicit model_error and does not checkpoint a failed turn', async () => {
  const { agent, checkpointStore } = setup([new Error('network unavailable')]);

  const result = await agent.runThread('thread-1', 'Hi');

  assert.equal(result.status, 'model_error');
  assert.match(result.error, /network unavailable/);
  assert.deepEqual(await checkpointStore.load('thread-1'), []);
});

test('restores state for the same thread and isolates different threads', async () => {
  const { agent, client } = setup([
    message({ content: [{ type: 'text', text: 'First reply' }] }),
    (params) => {
      assert.equal(hasTextBlock(params.messages, 'First reply'), true);
      return message({ content: [{ type: 'text', text: 'Same thread reply' }] });
    },
    (params) => {
      assert.equal(hasTextBlock(params.messages, 'First reply'), false);
      return message({ content: [{ type: 'text', text: 'Isolated reply' }] });
    },
  ]);

  await agent.runThread('thread-a', 'First');
  const sameThread = await agent.runThread('thread-a', 'Continue');
  const otherThread = await agent.runThread('thread-b', 'Separate');

  assert.equal(sameThread.text, 'Same thread reply');
  assert.equal(otherThread.text, 'Isolated reply');
  assert.equal(client.calls.length, 3);
});

test('event sink failures do not break the run', async () => {
  const { agent } = setup([
    message({ content: [{ type: 'text', text: 'Still works' }] }),
  ]);
  agent.eventSink = { emit() { throw new Error('collector down'); } };

  const result = await agent.run('Hi');

  assert.equal(result.status, 'completed');
});

test('reports classified tool failures in events without leaking runtime metadata to the SDK', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'unstable_dependency',
    description: 'Call an unstable dependency.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    policy: { timeoutMs: 10 },
    handler: () => new Promise(() => {}),
  });
  const client = new FakeAnthropicClient([
    message({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'slow_1', name: 'unstable_dependency', input: {} }],
    }),
    (params) => {
      const toolResult = params.messages.at(-1).content[0];
      assert.deepEqual(Object.keys(toolResult).sort(), [
        'content',
        'is_error',
        'tool_use_id',
        'type',
      ]);
      assert.equal(JSON.parse(toolResult.content).error.code, 'timeout');
      return message({ content: [{ type: 'text', text: 'The dependency timed out.' }] });
    },
  ]);
  const events = new InMemoryEventSink();
  const agent = new CodingAgent({
    client,
    tools,
    eventSink: events,
    config: { model: 'claude-test', maxTokens: 256 },
  });

  const result = await agent.run('Use the dependency');
  const toolEvent = events.events.find(({ name }) => name === 'tool.completed');

  assert.equal(result.status, 'completed');
  assert.equal(toolEvent.payload.errorCode, 'timeout');
  assert.equal(toolEvent.payload.retryable, true);
  assert.equal(typeof toolEvent.payload.durationMs, 'number');
});

function hasTextBlock(messages, expected) {
  return messages.some(({ content }) => Array.isArray(content)
    && content.some((block) => block.type === 'text' && block.text === expected));
}
