/**
 * Deterministic test double that implements only the public SDK boundary used
 * by the Agent: client.messages.create(params, options).
 */
export class FakeAnthropicClient {
  /** @param {(object | Error | ((params: object) => object | Error))[]} responses */
  constructor(responses) {
    this.responses = [...responses];
    /** @type {{params: object, options: object | undefined}[]} */
    this.calls = [];
    this.messages = {
      create: async (params, options) => {
        this.calls.push({ params: structuredClone(params), options });
        if (this.responses.length === 0) {
          throw new Error('FakeAnthropicClient has no response left');
        }
        const entry = this.responses.shift();
        const response = typeof entry === 'function' ? entry(params) : entry;
        if (response instanceof Error) throw response;
        return structuredClone(response);
      },
    };
  }
}

/**
 * Build a response with the same fields used from an Anthropic Message.
 * @param {{content: object[], stopReason?: string, inputTokens?: number, outputTokens?: number}} fields
 */
export function message({
  content,
  stopReason = 'end_turn',
  inputTokens = 10,
  outputTokens = 5,
}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}
