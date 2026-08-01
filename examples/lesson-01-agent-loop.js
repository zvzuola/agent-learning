import {
  CodingAgent,
  createClaudeRuntime,
  createProjectReader,
  createReadProjectFileTool,
  InMemoryEventSink,
  ToolRegistry,
} from '../src/index.js';

const claude = createClaudeRuntime();
const projectReader = createProjectReader({ rootDirectory: process.cwd() });

const tools = new ToolRegistry();
tools.register(createReadProjectFileTool(projectReader));

const events = new InMemoryEventSink();
const agent = new CodingAgent({
  client: claude.client,
  tools,
  eventSink: events,
  config: {
    model: claude.model,
    maxTokens: 1024,
    maxSteps: 6,
    maxToolCalls: 4,
    system: `You are a senior software development engineer working inside a project.
Inspect project files with tools before making claims about the codebase.
Give concise, actionable engineering analysis and never invent file contents.`,
  },
});

const input = process.argv.slice(2).join(' ')
  || 'Read package.json and summarize this project\'s runtime, dependencies, and available commands.';
const result = await agent.run(input);
console.log(`status=${result.status} steps=${result.steps}`);
console.log(`answer=${result.text}`);
printTrajectory(result.messages);
for (const event of events.events) {
  console.log(`step=${event.step} event=${event.name} ${JSON.stringify(event.payload)}`);
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
        console.log(`  ${index + 1}. ${message.role}.text ${JSON.stringify(truncate(block.text))}`);
      } else if (block.type === 'tool_use') {
        console.log(`  ${index + 1}. assistant.action ${block.name} ${JSON.stringify(block.input)}`);
      } else if (block.type === 'tool_result') {
        const outcome = block.is_error === true ? 'error' : 'observation';
        console.log(`  ${index + 1}. tool.${outcome} ${JSON.stringify(truncate(block.content))}`);
      }
    }
  }
}

function truncate(value, maxLength = 1_000) {
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}... [truncated]`;
}
