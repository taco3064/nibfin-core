import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { resourcePreparationLease } from '../src/managed-resource-admission.mjs';

const pending = { status: 'pending', code: 'RESOURCE_PREPARATION_PENDING' };
const deferred = () => Promise.withResolvers();

async function fixture(use) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-admission-'));
  const marker = join(directory, 'pending');
  const lease = async (action, options = {}) => {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      return await resourcePreparationLease(handle, action,
        { observe: () => lstat(marker), ...options });
    } finally { await handle.close(); }
  };
  try { await use({ directory, marker, lease }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('admission holds a shared kernel lease from guard observation through action',
  async () => fixture(async ({ lease, directory }) => {
    const observed = deferred();
    const inspected = deferred();
    const entered = deferred();
    const finish = deferred();
    const admission = lease(async () => {
      entered.resolve();
      await finish.promise;
      return 'admitted';
    }, { observe: async () => {
      observed.resolve();
      await inspected.promise;
      throw { code: 'ENOENT' };
    } });
    try {
      await observed.promise;
      const prepare = () => lease(() => assert.fail('preparation overlapped'),
        { preparing: true });
      assert.deepEqual(await prepare(), pending);
      inspected.resolve();
      await entered.promise;
      assert.deepEqual(await prepare(), pending);
      // Admissions remain concurrent, including nested admission wrappers.
      assert.equal(await lease(() => lease(() => 'second admission')),
        'second admission');
      const module = new URL('../src/managed-resource-admission.mjs', import.meta.url);
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { open } from 'node:fs/promises';
        import { resourcePreparationLease } from ${JSON.stringify(module.href)};
        const handle = await open(process.argv[1], 'r');
        try {
          const result = await resourcePreparationLease(handle,
            () => { throw new Error('overlapping preparation'); },
            { preparing: true });
          console.log(JSON.stringify(result));
        } finally { await handle.close(); }
      `, directory], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), pending);
    } finally {
      inspected.resolve();
      finish.resolve();
      assert.equal(await admission, 'admitted');
    }
    assert.equal(await lease(() => 'prepared', { preparing: true }), 'prepared');
  }));

test('preparation excludes admission and failed effects stay blocked after unlock',
  async () => fixture(async ({ lease, marker }) => {
    const entered = deferred();
    const finish = deferred();
    const preparation = lease(async () => {
      await writeFile(marker, 'owned pending effects');
      entered.resolve();
      await finish.promise;
      throw Object.assign(new Error('unknown effect'), { code: 'UNKNOWN_EFFECT' });
    }, { preparing: true });
    try {
      await entered.promise;
      assert.deepEqual(await lease(() => assert.fail('admitted during preparation')),
        pending);
      assert.deepEqual(await lease(() => assert.fail('parallel preparation'),
        { preparing: true }), pending);
    } finally {
      finish.resolve();
      await assert.rejects(preparation, { code: 'UNKNOWN_EFFECT' });
    }
    await assert.rejects(lease(() => assert.fail('admitted unresolved effects')),
      { code: 'RESOURCE_PREPARATION_RECONCILIATION_REQUIRED' });
    await lease(() => unlink(marker), { preparing: true });
    assert.equal(await lease(() => 'admitted after reconciliation'),
      'admitted after reconciliation');
  }));
