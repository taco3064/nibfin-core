import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as files from 'node:fs/promises';
import { join } from 'node:path';

const root = '/usr/local/libexec/nibfin/core-rollout/manager';
const directory = '/usr/local/libexec/nibfin/core-rollout/.previous-fixture';
let failure, removed, moved;
const original = new Error('original recovery publication failure');
const check = phase => { if (failure === phase) throw original; };
mock.module('node:fs/promises', { namedExports: { ...files,
  mkdtemp: async () => directory,
  rename: async (from, to) => {
    assert.equal(from, root);
    assert.equal(to, join(directory, 'package'));
    check('rename');
    moved = true;
  },
  rm: async path => { assert.equal(path, directory); removed = true; },
} });
mock.module('../src/rollout-manager-context.mjs', { namedExports: {
  managerRoot: root,
} });
mock.module('../src/owned-source-package.mjs', { namedExports: {
  verifyOwnedSourcePackage: async () => {},
} });
mock.module('../src/retirement-observe.mjs', { namedExports: {
  assertNoSlotMounts: async () => {},
} });
mock.module('../src/resource-references.mjs', { namedExports: {
  requireNoResourceReferences: async () => {},
} });
mock.module('../src/retirement-files.mjs', { namedExports: {
  writeRetirementFile: async () => check('pin'),
} });
mock.module('../src/recovery-lock.mjs', { namedExports: {
  syncRecoveryDirectory: async () => check('sync'),
} });
const { retainManagerPackage } = await import('../src/core-manager-recovery.mjs');
for (const phase of ['pin', 'rename', 'sync']) {
  failure = phase;
  removed = false;
  moved = false;
  await assert.rejects(retainManagerPackage({}), error => error === original);
  assert.equal(moved, phase === 'sync');
  assert.equal(removed, phase !== 'sync',
    'Only the pair without a moved manager is disposable');
}
