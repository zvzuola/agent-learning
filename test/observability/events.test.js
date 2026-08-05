import assert from 'node:assert/strict';
import test from 'node:test';

import { ConsoleEventSink } from '../../src/index.js';

test('prints an event when it is emitted', () => {
  const lines = [];
  const sink = new ConsoleEventSink({
    log: (line) => lines.push(line),
  });

  sink.emit({
    runId: 'run-1',
    step: 2,
    name: 'tool.completed',
    payload: { name: 'read_project_file', isError: false },
    timestamp: '2026-08-05T00:00:00.000Z',
  });

  assert.deepEqual(lines, [
    'step=2 event=tool.completed {"name":"read_project_file","isError":false}',
  ]);
});

test('requires a logging function', () => {
  assert.throws(
    () => new ConsoleEventSink({ log: null }),
    /log must be a function/,
  );
});
