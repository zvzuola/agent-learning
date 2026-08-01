import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class ClaudeConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ClaudeConfigError';
  }
}

/**
 * Resolve the system Claude settings file without requiring application
 * environment variables. CLAUDE_CONFIG_DIR is honored when Claude itself uses
 * a non-default configuration directory.
 */
export function getClaudeSettingsPath({
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  const configDirectory = nonEmpty(env.CLAUDE_CONFIG_DIR)
    ?? path.join(homeDirectory, '.claude');
  return path.resolve(configDirectory, 'settings.json');
}

/**
 * Load model and authentication settings used by the system Claude client.
 * Precedence: explicit options, process environment, Claude settings file.
 *
 * @param {object} [options]
 * @param {string} [options.settingsPath]
 * @param {string} [options.homeDirectory]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env]
 * @param {string} [options.model]
 * @param {import('@anthropic-ai/sdk').ClientOptions} [options.clientOptions]
 */
export function loadClaudeRuntimeConfig({
  settingsPath,
  homeDirectory,
  env = process.env,
  model,
  clientOptions = {},
} = {}) {
  const resolvedPath = settingsPath
    ? path.resolve(settingsPath)
    : getClaudeSettingsPath({ env, homeDirectory });
  const settings = readSettings(resolvedPath);
  const settingsEnv = isRecord(settings.env) ? settings.env : {};

  const explicitApiKey = nonEmpty(clientOptions.apiKey);
  const explicitAuthToken = nonEmpty(clientOptions.authToken);
  const credential = firstCredential([
    ['apiKey', explicitApiKey],
    ['authToken', explicitAuthToken],
    ['apiKey', nonEmpty(env.ANTHROPIC_API_KEY)],
    ['authToken', nonEmpty(env.ANTHROPIC_AUTH_TOKEN)],
    ['apiKey', nonEmpty(settingsEnv.ANTHROPIC_API_KEY)],
    ['authToken', nonEmpty(settingsEnv.ANTHROPIC_AUTH_TOKEN)],
  ]);

  if (!credential) {
    throw new ClaudeConfigError(
      `Claude authentication was not found in ${resolvedPath}`,
    );
  }

  const resolvedModel = nonEmpty(model)
    ?? nonEmpty(env.ANTHROPIC_MODEL)
    ?? nonEmpty(settingsEnv.ANTHROPIC_MODEL)
    ?? nonEmpty(settings.model);
  if (!resolvedModel) {
    throw new ClaudeConfigError(`Claude model was not found in ${resolvedPath}`);
  }

  const resolvedBaseURL = nonEmpty(clientOptions.baseURL)
    ?? nonEmpty(env.ANTHROPIC_BASE_URL)
    ?? nonEmpty(settingsEnv.ANTHROPIC_BASE_URL);
  const {
    apiKey: _apiKey,
    authToken: _authToken,
    baseURL: _baseURL,
    ...remainingClientOptions
  } = clientOptions;

  return {
    model: resolvedModel,
    settingsPath: resolvedPath,
    authType: credential.type,
    clientOptions: {
      ...remainingClientOptions,
      [credential.type]: credential.value,
      ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {}),
    },
  };
}

function readSettings(settingsPath) {
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new ClaudeConfigError(
        `Claude settings file was not found: ${settingsPath}`,
        { cause: error },
      );
    }
    throw new ClaudeConfigError(
      `Unable to read Claude settings file: ${settingsPath}`,
      { cause: error },
    );
  }

  try {
    const value = JSON.parse(raw);
    if (!isRecord(value)) throw new TypeError('settings must be an object');
    return value;
  } catch (error) {
    throw new ClaudeConfigError(
      `Claude settings file contains invalid JSON: ${settingsPath}`,
      { cause: error },
    );
  }
}

function firstCredential(candidates) {
  for (const [type, value] of candidates) {
    if (value) return { type, value };
  }
  return null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
