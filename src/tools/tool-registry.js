/**
 * A client-side business tool exposed to the Agent.
 *
 * The API only knows the JSON schema. The application owns validation and the
 * handler that may perform side effects.
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolDefinition>} */
    this.tools = new Map();
  }

  /** @param {ToolDefinition} tool */
  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** @returns {import('@anthropic-ai/sdk/resources/messages').Tool[]} */
  definitions() {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      input_schema: inputSchema,
    }));
  }

  /**
   * Execute one model-requested tool. Every failure is converted into a
   * model observation so the Agent can recover or explain the limitation.
   *
   * @param {{id: string, name: string, input: unknown}} call
   */
  async execute(call) {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return toolError(call.id, call.name, `Unknown tool: ${call.name}`);
    }

    try {
      const input = tool.validate ? tool.validate(call.input) : call.input;
      const value = await tool.handler(input);
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(value ?? null),
      };
    } catch (error) {
      return toolError(call.id, call.name, formatError(error));
    }
  }
}

/**
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema
 * @property {(input: unknown) => unknown} [validate]
 * @property {(input: any) => unknown | Promise<unknown>} handler
 */

/** @param {string} id @param {string} name @param {string} message */
function toolError(id, name, message) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: JSON.stringify({ tool: name, error: message }),
  };
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
