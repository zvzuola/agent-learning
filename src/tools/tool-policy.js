const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const IDEMPOTENCY_MODES = new Set(['none', 'optional', 'required', 'cache']);

/**
 * Centralized execution policy for business tools.
 *
 * A policy is deliberately separate from the model-facing JSON schema. The
 * schema describes what the model may ask for; this policy decides what the
 * application is willing to execute.
 */
export class ToolPolicy {
  /**
   * @param {object} [options]
   * @param {Iterable<string>} [options.allowedTools]
   * @param {Iterable<string>} [options.deniedTools]
   * @param {number|null} [options.defaultTimeoutMs]
   * @param {number|null} [options.defaultMaxResultBytes]
   * @param {'none'|'optional'|'required'|'cache'} [options.defaultIdempotency]
   * @param {Record<string, object>} [options.toolPolicies]
   */
  constructor(options = {}) {
    if (!isRecord(options)) {
      throw new TypeError('tool policy options must be an object');
    }

    this.allowedTools = toNameSet(options.allowedTools, 'allowedTools');
    this.deniedTools = toNameSet(options.deniedTools, 'deniedTools');
    this.defaultTimeoutMs = positiveIntegerOrNull(
      optionOrDefault(options, 'defaultTimeoutMs', DEFAULT_TIMEOUT_MS),
      'defaultTimeoutMs',
    );
    this.defaultMaxResultBytes = positiveIntegerOrNull(
      optionOrDefault(options, 'defaultMaxResultBytes', DEFAULT_MAX_RESULT_BYTES),
      'defaultMaxResultBytes',
    );
    this.defaultIdempotency = normalizeIdempotency(
      options.defaultIdempotency ?? 'none',
      'defaultIdempotency',
    );
    const configuredTools = options.toolPolicies ?? {};
    if (!isRecord(configuredTools)) {
      throw new TypeError('toolPolicies must be an object');
    }
    this.toolPolicies = new Map(Object.entries(configuredTools));
    for (const [name, policy] of this.toolPolicies) {
      if (!isRecord(policy)) {
        throw new TypeError(`Policy for ${name} must be an object`);
      }
      validateToolPolicy(policy, name);
    }
  }

  /**
   * Resolve the global policy and a tool's local policy into one immutable
   * execution decision.
   *
   * @param {{name: string, policy?: object}} tool
   */
  resolve(tool) {
    const local = this.toolPolicies.get(tool.name) ?? {};
    const declared = tool.policy ?? {};
    if (!isRecord(declared)) {
      throw new TypeError(`Policy for ${tool.name} must be an object`);
    }

    const merged = { ...declared, ...local };
    validateToolPolicy(merged, tool.name);

    const inAllowList = this.allowedTools.size === 0 || this.allowedTools.has(tool.name);
    const isDenied = this.deniedTools.has(tool.name)
      || merged.allow === false
      || !inAllowList;

    return {
      allowed: !isDenied,
      timeoutMs: Object.hasOwn(merged, 'timeoutMs')
        ? merged.timeoutMs
        : this.defaultTimeoutMs,
      maxResultBytes: Object.hasOwn(merged, 'maxResultBytes')
        ? merged.maxResultBytes
        : this.defaultMaxResultBytes,
      idempotency: normalizeIdempotency(
        merged.idempotency ?? this.defaultIdempotency,
        `Policy for ${tool.name}.idempotency`,
      ),
    };
  }
}

/** @param {ConstructorParameters<typeof ToolPolicy>[0]} [options] */
export function createToolPolicy(options = {}) {
  return new ToolPolicy(options);
}

/** @param {unknown} value @param {string} name */
function toNameSet(value, name) {
  if (value === undefined) return new Set();
  if (typeof value === 'string') return new Set([value]);
  if (!value || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`${name} must be an iterable of tool names`);
  }
  const names = new Set(value);
  if ([...names].some((item) => typeof item !== 'string' || !item)) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
  return names;
}

/** @param {unknown} value @param {string} name */
function positiveIntegerOrNull(value, name) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer or null`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function normalizeIdempotency(value, name) {
  if (value === true) return 'cache';
  if (value === false || value === undefined) return 'none';
  if (!IDEMPOTENCY_MODES.has(value)) {
    throw new RangeError(`${name} must be one of: none, optional, required, cache`);
  }
  return value;
}

/** @param {object} policy @param {string} name */
function validateToolPolicy(policy, name) {
  if ('timeoutMs' in policy) {
    positiveIntegerOrNull(policy.timeoutMs, `Policy for ${name}.timeoutMs`);
  }
  if ('maxResultBytes' in policy) {
    positiveIntegerOrNull(policy.maxResultBytes, `Policy for ${name}.maxResultBytes`);
  }
  if ('idempotency' in policy) {
    normalizeIdempotency(policy.idempotency, `Policy for ${name}.idempotency`);
  }
  if ('allow' in policy && typeof policy.allow !== 'boolean') {
    throw new TypeError(`Policy for ${name}.allow must be boolean`);
  }
}

function optionOrDefault(options, name, fallback) {
  return Object.hasOwn(options, name) ? options[name] : fallback;
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const toolPolicyDefaults = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
  idempotency: 'none',
});
