import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeConfigError,
  createClaudeRuntime,
  getClaudeSettingsPath,
  loadClaudeRuntimeConfig,
} from '../../src/index.js';

test('loads authentication, base URL and model from system Claude settings', async () => {
  const settingsPath = await writeSettings({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'system-token',
      ANTHROPIC_BASE_URL: 'https://claude.example.test',
      ANTHROPIC_MODEL: 'system-model',
    },
  });

  const config = loadClaudeRuntimeConfig({ settingsPath, env: {} });

  assert.equal(config.model, 'system-model');
  assert.equal(config.authType, 'authToken');
  assert.equal(config.clientOptions.authToken, 'system-token');
  assert.equal(config.clientOptions.baseURL, 'https://claude.example.test');
  assert.equal('apiKey' in config.clientOptions, false);
});

test('uses top-level Claude model when env model is absent', async () => {
  const settingsPath = await writeSettings({
    model: 'top-level-model',
    env: { ANTHROPIC_API_KEY: 'system-api-key' },
  });

  const config = loadClaudeRuntimeConfig({ settingsPath, env: {} });

  assert.equal(config.model, 'top-level-model');
  assert.equal(config.authType, 'apiKey');
  assert.equal(config.clientOptions.apiKey, 'system-api-key');
});

test('explicit options and process environment override the settings file', async () => {
  const settingsPath = await writeSettings({
    model: 'settings-model',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'settings-token',
      ANTHROPIC_BASE_URL: 'https://settings.example.test',
    },
  });

  const fromEnvironment = loadClaudeRuntimeConfig({
    settingsPath,
    env: {
      ANTHROPIC_API_KEY: 'environment-key',
      ANTHROPIC_MODEL: 'environment-model',
      ANTHROPIC_BASE_URL: 'https://environment.example.test',
    },
  });
  const explicit = loadClaudeRuntimeConfig({
    settingsPath,
    env: {},
    model: 'explicit-model',
    clientOptions: {
      authToken: 'explicit-token',
      baseURL: 'https://explicit.example.test',
      timeout: 1_000,
    },
  });

  assert.equal(fromEnvironment.authType, 'apiKey');
  assert.equal(fromEnvironment.model, 'environment-model');
  assert.equal(fromEnvironment.clientOptions.baseURL, 'https://environment.example.test');
  assert.equal(explicit.authType, 'authToken');
  assert.equal(explicit.model, 'explicit-model');
  assert.equal(explicit.clientOptions.baseURL, 'https://explicit.example.test');
  assert.equal(explicit.clientOptions.timeout, 1_000);
});

test('resolves the default settings path from the user home', () => {
  const homeDirectory = path.join(tmpdir(), 'learner');
  const settingsPath = getClaudeSettingsPath({
    env: {},
    homeDirectory,
  });

  assert.equal(settingsPath, path.join(homeDirectory, '.claude', 'settings.json'));
});

test('runtime metadata never exposes credential values', async () => {
  const settingsPath = await writeSettings({
    model: 'safe-model',
    env: { ANTHROPIC_AUTH_TOKEN: 'do-not-expose' },
  });

  const runtime = createClaudeRuntime({ settingsPath, env: {} });

  assert.equal(runtime.model, 'safe-model');
  assert.equal(runtime.authType, 'authToken');
  assert.equal(typeof runtime.client.messages.create, 'function');
  const publicMetadata = {
    model: runtime.model,
    authType: runtime.authType,
    settingsPath: runtime.settingsPath,
  };
  assert.equal(JSON.stringify(publicMetadata).includes('do-not-expose'), false);
});

test('reports missing and malformed Claude settings without leaking content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-learning-'));
  const missingPath = path.join(directory, 'missing.json');
  const malformedPath = path.join(directory, 'malformed.json');
  await writeFile(malformedPath, '{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"}', 'utf8');

  assert.throws(
    () => loadClaudeRuntimeConfig({ settingsPath: missingPath, env: {} }),
    (error) => error instanceof ClaudeConfigError && /was not found/.test(error.message),
  );
  assert.throws(
    () => loadClaudeRuntimeConfig({ settingsPath: malformedPath, env: {} }),
    (error) => error instanceof ClaudeConfigError
      && /invalid JSON/.test(error.message)
      && !error.message.includes('secret'),
  );
});

test('reports missing authentication or model clearly', async () => {
  const noAuth = await writeSettings({ model: 'configured-model' });
  const noModel = await writeSettings({
    env: { ANTHROPIC_AUTH_TOKEN: 'configured-token' },
  });

  assert.throws(
    () => loadClaudeRuntimeConfig({ settingsPath: noAuth, env: {} }),
    /authentication was not found/,
  );
  assert.throws(
    () => loadClaudeRuntimeConfig({ settingsPath: noModel, env: {} }),
    /model was not found/,
  );
});

async function writeSettings(value) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-learning-'));
  const settingsPath = path.join(directory, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(value), 'utf8');
  return settingsPath;
}
