import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'scripts', 'sample.mjs'), 'export const value = 1;');
  await writeFile(join(root, 'test', 'sample.test.mjs'), '// syntax-only fixture');
  await writeFile(join(root, '.node-version'), process.versions.node);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    type: 'module', engines: { node: process.versions.node },
  }));
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}

test('checks nested modules without executing them', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'nested', 'valid.mjs'), 'throw new Error("must not run");');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Syntax checked 3/);
});

test('rejects syntax errors in nested modules', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'nested', 'invalid.mjs'), 'export const = ;');
  assert.notEqual(check(root).status, 0);
});

test('rejects missing or malformed package configuration', async t => {
  const root = await fixture(t);
  await rm(join(root, 'package.json'));
  assert.notEqual(check(root).status, 0);
  await writeFile(join(root, 'package.json'), '{invalid');
  assert.notEqual(check(root).status, 0);
});

test('rejects inconsistent runtime pins', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.node-version'), '0.0.0');
  assert.notEqual(check(root).status, 0);
});

test('rejects a missing test directory', async t => {
  const root = await fixture(t);
  await rm(join(root, 'test'), { recursive: true });
  assert.notEqual(check(root).status, 0);
});
