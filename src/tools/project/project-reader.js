import { open, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 128 * 1024;

/**
 * Creates a workspace-scoped file reader for coding tools.
 *
 * @param {object} [options]
 * @param {string} [options.rootDirectory]
 * @param {number} [options.maxBytes]
 */
export function createProjectReader({
  rootDirectory = process.cwd(),
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const root = path.resolve(rootDirectory);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive integer');
  }

  return {
    /** @param {string} relativePath */
    async readTextFile(relativePath) {
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        throw new TypeError('path is required');
      }

      const target = path.resolve(root, relativePath);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Path must stay inside the project workspace');
      }

      const metadata = await stat(target);
      if (!metadata.isFile()) {
        throw new Error('Path must point to a regular file');
      }
      if (metadata.size > maxBytes) {
        throw new Error(`File exceeds the ${maxBytes}-byte reading limit`);
      }

      const file = await open(target, 'r');
      try {
        return await file.readFile({ encoding: 'utf8' });
      } finally {
        await file.close();
      }
    },
  };
}
