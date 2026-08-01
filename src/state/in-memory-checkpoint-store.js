/**
 * Minimal checkpoint contract for the course. Replace this adapter with a
 * durable database-backed implementation before running multiple instances.
 */
export class InMemoryCheckpointStore {
  constructor() {
    /** @type {Map<string, import('@anthropic-ai/sdk/resources/messages').MessageParam[]>} */
    this.snapshots = new Map();
  }

  /** @param {string} threadId */
  async load(threadId) {
    return structuredClone(this.snapshots.get(threadId) ?? []);
  }

  /** @param {string} threadId @param {import('@anthropic-ai/sdk/resources/messages').MessageParam[]} messages */
  async save(threadId, messages) {
    this.snapshots.set(threadId, structuredClone(messages));
  }
}
