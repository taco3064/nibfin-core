import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('public fixed wrapper refuses caller-selected arguments before host access', () => {
  for (const arg of ['/caller/target', '--all', '--help']) {
    const result = spawnSync('/bin/sh', ['bin/nibfin-reclaim', arg]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
  }
  const result = spawnSync(process.execPath, ['bin/nibfin-reclaim.mjs', '/target']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0);
});

test('root runtime verifies sources and sanitizes both fixed entries', async t => {
  await mkdir('.npm', { recursive: true });
  const root = await mkdtemp(resolve('.npm/reclamation-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('python3', ['test/storage-reclamation-runtime.py', root],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Controlled reclamation runtime dispatch passed/);
});
