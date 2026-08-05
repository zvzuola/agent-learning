import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryIdempotencyStore,
  ToolExecutionError,
  ToolPolicy,
  ToolRegistry,
} from '../../src/index.js';

test('exposes and executes only tools allowed by policy', async () => {
  const registry = new ToolRegistry({
    policy: new ToolPolicy({ allowedTools: ['inspect'] }),
  });
  registry.register(createTool('inspect'));
  registry.register(createTool('delete_record'));

  assert.deepEqual(registry.definitions().map(({ name }) => name), ['inspect']);

  const denied = await registry.execute(call('delete_record'));

  assertToolError(denied, 'policy_denied', false);
});

test('classifies unknown tools, invalid input and dependency failures', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry();
  registry.register(createTool('validated', {
    validate(input) {
      if (input.value !== 'valid') throw new TypeError('value must be valid');
      return input;
    },
    handler() {
      handlerCalls += 1;
      throw new Error('database unavailable');
    },
  }));

  assertToolError(await registry.execute(call('missing')), 'tool_not_found', false);
  assertToolError(
    await registry.execute(call('validated', { value: 'invalid' })),
    'validation_error',
    false,
  );
  assert.equal(handlerCalls, 0);
  const unexpected = await registry.execute(call('validated', { value: 'valid' }));
  assertToolError(unexpected, 'execution_error', false);
  assert.equal(unexpected.content.includes('database unavailable'), false);
  assert.equal(handlerCalls, 1);
});

test('preserves stable business error codes and retry guidance', async () => {
  const registry = new ToolRegistry();
  registry.register(createTool('reserve_capacity', {
    handler() {
      throw new ToolExecutionError(
        'capacity_unavailable',
        'No capacity is currently available',
        { retryable: true },
      );
    },
  }));

  const result = await registry.execute(call('reserve_capacity'));
  const content = JSON.parse(result.content);

  assertToolError(result, 'capacity_unavailable', true);
  assert.equal(content.error.message, 'No capacity is currently available');
});

test('times out slow tools and cooperatively aborts their work', async () => {
  let observedAbort = false;
  const registry = new ToolRegistry();
  registry.register(createTool('slow_dependency', {
    policy: { timeoutMs: 20 },
    async handler(input, { signal }) {
      void input;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        signal.addEventListener('abort', () => {
          observedAbort = true;
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return 'too late';
    },
  }));

  const result = await registry.execute(call('slow_dependency'));

  assertToolError(result, 'timeout', true);
  assert.equal(observedAbort, true);
  assert.ok(result.metadata.durationMs >= 10);
  assert.ok(result.metadata.durationMs < 1_000);
});

test('classifies caller cancellation separately from timeout', async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  registry.register(createTool('wait_for_signal', {
    policy: { timeoutMs: null },
    handler(input, { signal }) {
      void input;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void resolve;
      });
    },
  }));

  const pending = registry.execute(call('wait_for_signal'), { signal: controller.signal });
  controller.abort(new DOMException('User cancelled the run', 'AbortError'));
  const result = await pending;

  assertToolError(result, 'cancelled', false);
});

test('rejects oversized results before returning them to the model', async () => {
  const registry = new ToolRegistry();
  registry.register(createTool('large_result', {
    policy: { maxResultBytes: 16 },
    handler: () => ({ content: 'x'.repeat(100) }),
  }));

  const result = await registry.execute(call('large_result'));

  assertToolError(result, 'result_too_large', false);
  assert.equal(result.content.includes('x'.repeat(100)), false);
});

test('classifies tool results that cannot be serialized as JSON', async () => {
  const registry = new ToolRegistry();
  registry.register(createTool('circular_result', {
    handler() {
      const value = {};
      value.self = value;
      return value;
    },
  }));

  const result = await registry.execute(call('circular_result'));

  assertToolError(result, 'result_serialization_error', false);
});

test('deduplicates concurrent and repeated calls with the same key', async () => {
  let handlerCalls = 0;
  const propagatedKeys = [];
  let release;
  const dependency = new Promise((resolve) => { release = resolve; });
  const registry = new ToolRegistry();
  registry.register(createTool('create_order', {
    policy: { idempotency: 'required' },
    idempotencyKey: ({ requestId }) => requestId,
    async handler(input, { idempotencyKey }) {
      handlerCalls += 1;
      propagatedKeys.push(idempotencyKey);
      await dependency;
      return { orderId: 'order-1', amount: input.amount };
    },
  }));
  const input = { requestId: 'request-1', amount: 42 };

  const first = registry.execute(call('create_order', input, 'toolu_1'));
  const concurrent = registry.execute(call('create_order', input, 'toolu_2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handlerCalls, 1);
  assert.deepEqual(propagatedKeys, ['request-1']);
  release();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  const repeated = await registry.execute(call('create_order', input, 'toolu_3'));

  assert.equal(handlerCalls, 1);
  assert.equal(firstResult.metadata.replayed, false);
  assert.equal(concurrentResult.metadata.replayed, true);
  assert.equal(repeated.metadata.replayed, true);
  assert.equal(concurrentResult.tool_use_id, 'toolu_2');
  assert.equal(repeated.tool_use_id, 'toolu_3');
  assert.deepEqual(JSON.parse(repeated.content), { orderId: 'order-1', amount: 42 });
});

test('requires idempotency keys and rejects key reuse with different input', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry();
  registry.register(createTool('charge', {
    policy: { idempotency: 'required' },
    handler(input) {
      handlerCalls += 1;
      return { amount: input.amount };
    },
  }));

  assertToolError(await registry.execute(call('charge', { amount: 10 })), 'idempotency_key_required');
  await registry.execute(call('charge', { amount: 10 }), { idempotencyKey: 'payment-1' });
  const conflict = await registry.execute(
    call('charge', { amount: 20 }),
    { idempotencyKey: 'payment-1' },
  );

  assertToolError(conflict, 'idempotency_conflict', false);
  assert.equal(handlerCalls, 1);
});

test('rejects mismatched context and business idempotency keys', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry();
  registry.register(createTool('keyed_write', {
    policy: { idempotency: 'required' },
    idempotencyKey: ({ requestId }) => requestId,
    handler() {
      handlerCalls += 1;
      return { created: true };
    },
  }));

  const result = await registry.execute(
    call('keyed_write', { requestId: 'business-key' }),
    { idempotencyKey: 'context-key' },
  );

  assertToolError(result, 'idempotency_key_mismatch', false);
  assert.equal(handlerCalls, 0);
});

test('does not cache failed idempotent calls', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry();
  registry.register(createTool('flaky_write', {
    policy: { idempotency: 'required' },
    idempotencyKey: ({ requestId }) => requestId,
    handler() {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        throw new ToolExecutionError('temporarily_unavailable', 'Try again', { retryable: true });
      }
      return { created: true };
    },
  }));

  const first = await registry.execute(call('flaky_write', { requestId: 'retry-1' }));
  const retry = await registry.execute(call('flaky_write', { requestId: 'retry-1' }));

  assertToolError(first, 'temporarily_unavailable', true);
  assert.equal(retry.is_error, undefined);
  assert.equal(retry.metadata.replayed, false);
  assert.equal(handlerCalls, 2);
});

test('allows retry when the idempotency store fails before running the dependency', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry({
    idempotencyStore: {
      claim() { throw new Error('store unavailable'); },
      complete() {},
      release() {},
    },
  });
  registry.register(createTool('stored_write', {
    policy: { idempotency: 'required' },
    handler() {
      handlerCalls += 1;
      return { created: true };
    },
  }));

  const result = await registry.execute(
    call('stored_write'),
    { idempotencyKey: 'write-1' },
  );

  assertToolError(result, 'idempotency_store_read_error', true);
  assert.equal(result.content.includes('store unavailable'), false);
  assert.equal(handlerCalls, 0);
});

test('does not recommend retry after a completed side effect fails to persist', async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry({
    idempotencyStore: {
      claim() { return { status: 'claimed', token: 'claim-1' }; },
      complete() { throw new Error('store unavailable'); },
      release() {},
    },
  });
  registry.register(createTool('uncertain_write', {
    policy: { idempotency: 'required' },
    handler() {
      handlerCalls += 1;
      return { created: true };
    },
  }));

  const result = await registry.execute(
    call('uncertain_write'),
    { idempotencyKey: 'write-1' },
  );

  assertToolError(result, 'idempotency_store_write_error', false);
  assert.equal(result.content.includes('store unavailable'), false);
  assert.equal(handlerCalls, 1);
});

test('validates policies and bounds the in-memory idempotency store', async () => {
  assert.throws(() => new ToolPolicy({ defaultTimeoutMs: 0 }), /positive integer or null/);
  assert.throws(
    () => new ToolPolicy({ toolPolicies: { inspect: { idempotency: 'sometimes' } } }),
    /none, optional, required, cache/,
  );
  assert.throws(() => new InMemoryIdempotencyStore({ maxEntries: 0 }), /positive integer/);

  const store = new InMemoryIdempotencyStore({ maxEntries: 1 });
  const first = await store.claim('first', 'fingerprint-1');
  assert.equal(first.status, 'claimed');
  await store.complete('first', first.token, { value: 1 });
  assert.deepEqual(await store.claim('first', 'fingerprint-1'), {
    status: 'replay',
    result: { value: 1 },
  });
  assert.deepEqual(await store.claim('first', 'different'), { status: 'conflict' });
  assert.deepEqual(await store.claim('second', 'fingerprint-2'), {
    status: 'capacity_exhausted',
  });
});

test('atomically prevents duplicate side effects across registries', async () => {
  let handlerCalls = 0;
  let release;
  const dependency = new Promise((resolve) => { release = resolve; });
  const store = new InMemoryIdempotencyStore();
  const firstRegistry = new ToolRegistry({ idempotencyStore: store });
  const secondRegistry = new ToolRegistry({ idempotencyStore: store });
  const tool = createTool('shared_write', {
    policy: { idempotency: 'required' },
    async handler() {
      handlerCalls += 1;
      await dependency;
      return { created: true };
    },
  });
  firstRegistry.register(tool);
  secondRegistry.register({ ...tool });

  const first = firstRegistry.execute(
    call('shared_write'),
    { idempotencyKey: 'shared-1' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const competing = await secondRegistry.execute(
    call('shared_write'),
    { idempotencyKey: 'shared-1' },
  );
  assertToolError(competing, 'idempotency_in_progress', true);
  assert.equal(handlerCalls, 1);

  release();
  await first;
  const replay = await secondRegistry.execute(
    call('shared_write'),
    { idempotencyKey: 'shared-1' },
  );

  assert.equal(replay.metadata.replayed, true);
  assert.equal(handlerCalls, 1);
});

function createTool(name, overrides = {}) {
  return {
    name,
    description: `Execute ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    handler: (input) => ({ input }),
    ...overrides,
  };
}

function call(name, input = {}, id = 'toolu_test') {
  return { id, name, input };
}

function assertToolError(result, code, retryable) {
  const content = JSON.parse(result.content);
  assert.equal(result.is_error, true);
  assert.equal(content.error.code, code);
  assert.equal(result.metadata.errorCode, code);
  if (retryable !== undefined) {
    assert.equal(content.error.retryable, retryable);
    assert.equal(result.metadata.retryable, retryable);
  }
}
