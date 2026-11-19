import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as files from 'node:fs/promises';

const destination = '/fixed/client.py';
const expected = Buffer.from('verified entry');
let failure;
let secondary = false;
let renamed = false;
const staged = new Set();
let current = null;
const original = new Error('original fixture failure');
const check = name => {
  if (failure === name) throw original;
};
mock.module('../src/host-paths.mjs', { namedExports: {
  rootOwnedPath: async () => {},
} });
mock.module('../src/recovery-lock.mjs', { namedExports: {
  syncRecoveryDirectory: async () => {},
} });
mock.module('node:fs/promises', { namedExports: {
  ...files,
  lstat: async () => {
    if (current === null) throw Object.assign(new Error(), { code: 'ENOENT' });
    return { isFile: () => true, nlink: 1, mode: 0o755 };
  },
  readFile: async () => current,
  open: async path => {
    staged.add(path);
    return Object.fromEntries(['chown', 'chmod', 'writeFile', 'sync', 'close']
      .map(name => [name, async () => {
        check(name);
        if (secondary && name === 'close') throw new Error('secondary close');
      }]));
  },
  rename: async path => {
    check('rename');
    assert.ok(staged.delete(path));
    renamed = true;
    current = expected;
  },
  unlink: async path => {
    staged.delete(path);
    if (secondary) throw new Error('secondary unlink');
  },
} });
const { publishMaintenanceFile } = await import('../src/core-maintenance-files.mjs');
for (const point of ['chown', 'chmod', 'writeFile', 'sync', 'close', 'validate',
  'rename']) {
  failure = point;
  renamed = false;
  current = null;
  await assert.rejects(publishMaintenanceFile(destination, expected, [], 0o755,
    async () => check('validate')), error => error === original);
  assert.equal(staged.size, 0, `${point} must clean its own staged file`);
  assert.equal(renamed, false);
  failure = undefined;
  assert.equal(await publishMaintenanceFile(destination, expected, [], 0o755), true);
  assert.equal(await publishMaintenanceFile(destination, expected, [], 0o755), false);
}
current = null;
failure = 'writeFile';
secondary = true;
await assert.rejects(publishMaintenanceFile(destination, expected, [], 0o755),
  error => error === original);
assert.equal(staged.size, 0);
