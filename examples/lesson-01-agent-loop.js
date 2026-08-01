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
for (const event of events.events) {
  console.log(`step=${event.step} event=${event.name} ${JSON.stringify(event.payload)}`);
}
