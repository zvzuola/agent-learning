import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * Process-local implementation of the atomic idempotency-store contract.
 *
 * It is useful for tests and single-process examples. Production deployments
 * should inject a shared store whose claim operation is atomic across workers.
 */
export class InMemoryIdempotencyStore {
  /** @param {{maxEntries?: number}} [options] */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  /**
   * Atomically reserve a key or inspect its existing state.
   *
   * @param {string} key
   * @param {string} fingerprint
   */
  async claim(key, fingerprint) {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { status: 'conflict' };
      if (existing.status === 'completed') {
        return {
          status: 'replay',
          result: structuredClone(existing.result),
        };
      }
      return { status: 'in_progress' };
    }

    if (this.entries.size >= this.maxEntries) {
      return { status: 'capacity_exhausted' };
    }

    const token = randomUUID();
    this.entries.set(key, {
      status: 'in_progress',
      fingerprint,
      token,
    });
    return { status: 'claimed', token };
  }

  /**
   * Commit a successful or otherwise terminal execution result.
   *
   * @param {string} key
   * @param {string} token
   * @param {unknown} result
   */
  async complete(key, token, result) {
    const claimed = this.#ownedClaim(key, token);
    this.entries.set(key, {
      status: 'completed',
      fingerprint: claimed.fingerprint,
      result: structuredClone(result),
    });
  }

  /**
   * Release a failed attempt so the same business operation may be retried.
   *
   * @param {string} key
   * @param {string} token
   */
  async release(key, token) {
    this.#ownedClaim(key, token);
    this.entries.delete(key);
  }

  #ownedClaim(key, token) {
    const entry = this.entries.get(key);
    if (entry?.status !== 'in_progress' || entry.token !== token) {
      throw new Error('Idempotency claim is missing or is owned by another execution');
    }
    return entry;
  }
}
