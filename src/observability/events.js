/**
 * @typedef {object} AgentEvent
 * @property {string} runId
 * @property {number} step
 * @property {'run.started'|'model.completed'|'tool.completed'|'run.completed'|'run.failed'|'run.stopped'} name
 * @property {Record<string, unknown>} payload
 * @property {string} timestamp
 */

export class InMemoryEventSink {
  constructor() {
    /** @type {AgentEvent[]} */
    this.events = [];
  }

  /** @param {AgentEvent} event */
  emit(event) {
    this.events.push(event);
  }
}

export class NullEventSink {
  /** @param {AgentEvent} event */
  emit(event) {
    void event;
  }
}

/** @param {string} runId @param {number} step @param {AgentEvent['name']} name @param {Record<string, unknown>} payload */
export function createEvent(runId, step, name, payload = {}) {
  return {
    runId,
    step,
    name,
    payload,
    timestamp: new Date().toISOString(),
  };
}
