import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { upgradeOperationStore } from '../src/upgrade-operation-store.mjs';

function operation(id, overrides = {}) {
  return { id, intent: { repositories: [42], source: id }, memberId: 9,
    execution: { repositoryId: 42 }, consumers: [], ...overrides };
}

async function fixture(t, legacy) {
  const scratch = join(process.cwd(), '.deliver-test-tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'upgrade-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'upgrade.sqlite');
  const store = () => upgradeOperationStore({
    path, legacy: join(root, 'upgrade.json'),
    verify: async value => assert(value === path || value === dirname(path)),
    readLegacy: async () => legacy,
  });
  return { path, store };
}

test('legacy data and independent overlapping writes survive native transactions', {
  skip: process.platform !== 'linux' && 'Core management runs on Linux',
}, async t => {
  const original = operation('original');
  const legacy = { schemaVersion: 1, operations: [original] };
  const { store } = await fixture(t, legacy);
  const [cli, native] = [store(), store()];
  const cliRead = await cli.read();
  const nativeRead = await native.read();
  const [alpha, beta] = [operation('cli'), operation('native')];
  await cli.write([...cliRead, alpha]);
  await native.write([...nativeRead, beta]);
  legacy.operations.length = 0;
  assert.deepEqual(await store().read(), [original, alpha, beta]);
});

test('busy writes require a new read without replacing confirmed native identity', {
  skip: process.platform !== 'linux' && 'Core management runs on Linux',
}, async t => {
  const { path, store } = await fixture(t, null);
  const cli = store();
  await cli.read();
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.deepEqual(await store().read(), []);
    await assert.rejects(cli.write([operation('alpha')]),
      { code: 'UPGRADE_OPERATION_STATE_BUSY' });
    db.exec('ROLLBACK');
  } finally { db.close(); }
  const other = store();
  await other.read();
  const original = operation('alpha');
  await cli.write([original]);
  await assert.rejects(other.write([{ ...original, id: 'beta' }]),
    { code: 'UPGRADE_OPERATION_CHANGED' });
  assert.deepEqual(await store().read(), [original]);
});
