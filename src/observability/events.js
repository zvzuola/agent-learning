/**
 * @typedef {object} AgentEvent
 * @property {string} runId
 * @property {number} step
 * @property {'run.started'|'model.started'|'model.completed'|'tool.completed'|'run.completed'|'run.failed'|'run.stopped'} name
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

export class ConsoleEventSink {
  /** @param {{log?: (line: string) => unknown}} [options] */
  constructor({ log = console.log } = {}) {
    if (typeof log !== 'function') {
      throw new TypeError('log must be a function');
    }
    this.log = log;
  }

  /** @param {AgentEvent} event */
  emit(event) {
    this.log(
      `step=${event.step} event=${event.name} ${JSON.stringify(event.payload)}`,
    );
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
