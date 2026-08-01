import Anthropic from '@anthropic-ai/sdk';

import { loadClaudeRuntimeConfig } from '../config/claude-config.js';

/**
 * Create a ready-to-use SDK client and resolve the configured Claude model.
 * Secrets remain inside the client and are never included in the return value.
 *
 * @param {Parameters<typeof loadClaudeRuntimeConfig>[0]} [options]
 */
export function createClaudeRuntime(options = {}) {
  const config = loadClaudeRuntimeConfig(options);
  return {
    client: new Anthropic(config.clientOptions),
    model: config.model,
    settingsPath: config.settingsPath,
    authType: config.authType,
  };
}
