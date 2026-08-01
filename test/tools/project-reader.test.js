import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectReader } from '../../src/index.js';

test('reads UTF-8 files inside the project workspace', async () => {
  const root = await createWorkspace();
  const reader = createProjectReader({ rootDirectory: root });

  const content = await reader.readTextFile('src/index.js');

  assert.equal(content, 'export const answer = 42;\n');
});

test('rejects paths outside the project workspace', async () => {
  const root = await createWorkspace();
  const reader = createProjectReader({ rootDirectory: root });

  await assert.rejects(
    () => reader.readTextFile('../outside.txt'),
    /inside the project workspace/,
  );
});

test('rejects directories and files above the configured size limit', async () => {
  const root = await createWorkspace();
  const reader = createProjectReader({ rootDirectory: root, maxBytes: 8 });

  await assert.rejects(() => reader.readTextFile('src'), /regular file/);
  await assert.rejects(() => reader.readTextFile('src/index.js'), /reading limit/);
});

test('requires a positive file-size limit and non-empty path', async () => {
  const root = await createWorkspace();

  assert.throws(
    () => createProjectReader({ rootDirectory: root, maxBytes: 0 }),
    /positive integer/,
  );
  const reader = createProjectReader({ rootDirectory: root });
  await assert.rejects(() => reader.readTextFile(''), /path is required/);
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
  return root;
}
