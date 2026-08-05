import { z } from 'zod';

import {
  CodingAgent,
  ConsoleEventSink,
  createClaudeRuntime,
  ToolExecutionError,
  ToolPolicy,
  ToolRegistry,
} from '../src/index.js';

const claude = createClaudeRuntime();
const attempts = new Map();
const tools = new ToolRegistry({
  policy: new ToolPolicy({
    allowedTools: ['submit_work_item'],
    defaultTimeoutMs: 1_000,
    defaultMaxResultBytes: 16 * 1024,
  }),
});
tools.register(createSubmitWorkItemTool(attempts));

const agent = new CodingAgent({
  client: claude.client,
  tools,
  eventSink: new ConsoleEventSink(),
  config: {
    model: claude.model,
    maxTokens: 1_024,
    maxSteps: 8,
    maxToolCalls: 5,
    system: `You operate reliable business tools.
Treat tool error objects as observations, not successful outcomes.
Retry only when error.retryable is true, at most once, and preserve request_id exactly.
Never change an idempotency key while retrying the same business operation.`,
  },
});

const input = process.argv.slice(2).join(' ') || `Submit a work item titled
"Review the Lesson 02 tool policy" with request_id "lesson-02-demo".
If the first call returns a retryable error, retry once with exactly the same input.
After success, call the tool once more with exactly the same input to demonstrate replay,
then summarize what happened.`;
const result = await agent.run(input);

console.log(`status=${result.status} steps=${result.steps}`);
console.log(`answer=${result.text}`);
printTrajectory(result.messages);

function createSubmitWorkItemTool(attemptsByRequest) {
  const schema = z.object({
    request_id: z.string().min(1),
    title: z.string().min(1).max(200),
  }).strict();

  return {
    name: 'submit_work_item',
    description: `Submit one work item. This operation has side effects.
Use a stable request_id and preserve it when retrying the same operation.`,
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          minLength: 1,
          description: 'Stable idempotency key chosen once for this business operation.',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ['request_id', 'title'],
      additionalProperties: false,
    },
    validate: (value) => schema.parse(value),
    policy: {
      timeoutMs: 500,
      idempotency: 'required',
    },
    idempotencyKey: ({ request_id: requestId }) => requestId,
    async handler({ request_id: requestId, title }, { idempotencyKey, signal }) {
      await delay(25, signal);
      const attempt = (attemptsByRequest.get(requestId) ?? 0) + 1;
      attemptsByRequest.set(requestId, attempt);

      if (attempt === 1) {
        throw new ToolExecutionError(
          'service_unavailable',
          'The work-item service is temporarily unavailable',
          { retryable: true },
        );
      }

      return {
        workItemId: 'work-item-lesson-02',
        title,
        idempotencyKey,
        acceptedAttempt: attempt,
      };
    },
  };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function printTrajectory(messages) {
  console.log('trajectory:');
  for (const [index, message] of messages.entries()) {
    if (typeof message.content === 'string') {
      console.log(`  ${index + 1}. ${message.role}.text ${JSON.stringify(message.content)}`);
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        console.log(`  ${index + 1}. ${message.role}.text ${JSON.stringify(block.text)}`);
      } else if (block.type === 'tool_use') {
        console.log(`  ${index + 1}. assistant.action ${block.name} ${JSON.stringify(block.input)}`);
      } else if (block.type === 'tool_result') {
        const outcome = block.is_error === true ? 'error' : 'observation';
        console.log(`  ${index + 1}. tool.${outcome} ${block.content}`);
      }
    }
  }
}
