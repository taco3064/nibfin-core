import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { recoverStaleOrigin } from '../src/rollout-recovery.mjs';
import { settleLifecycleNotifications } from '../src/lifecycle-settlement.mjs';
import { readRelayState } from '../src/relay-state.mjs';
import { RelayJournal, withRelayGate, writeRelayState } from '../src/relay-state.mjs';
import { settlePoolWork } from '../src/retirement-observe.mjs';
import { settleRolloutWork } from '../src/rollout-pool.mjs';
import { recoverRolloutOrigins } from '../src/rollout-recovery.mjs';

test('rollout consumers link to the shared pool settlement interface', () => {
  assert.equal(typeof settlePoolWork, 'function');
  assert.equal(typeof settleRolloutWork, 'function');
  assert.equal(typeof recoverRolloutOrigins, 'function');
});

test('relay settlement keeps global rollout checks and scoped retirement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-compatibility-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new RelayJournal(root);
  await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: true });
  const pending = { status: 'pending' };
  journal.records = async () => [pending];
  await assert.rejects(journal.requireEffectsSettled(),
    { code: 'RETIREMENT_RELAY_EFFECT_PENDING' });
  await withRelayGate(root, async () => {
    await assert.rejects(journal.requireEffectsSettledUnderGate(),
      { code: 'RETIREMENT_RELAY_EFFECT_PENDING' });
  });
  await journal.requireSettled(() => false);
  await assert.rejects(journal.requireSettled(),
    { code: 'RETIREMENT_RELAY_EFFECT_PENDING' });
  pending.status = 'consumed';
  const replacement = 'replacement-' + 'a'.repeat(64) + '.json';
  await writeRelayState(root, replacement, { status: 'pending' });
  await assert.rejects(journal.requireEffectsSettled(),
    { code: 'ROLLOUT_REPLACEMENT_PENDING' });
  await journal.requireReplacementEffectsSettled({ except: replacement });
  await assert.rejects(journal.requireReplacementEffectsSettled(),
    { code: 'ROLLOUT_REPLACEMENT_PENDING' });
  await writeRelayState(root, replacement, { status: 'scheduled' });
  await journal.requireEffectsSettled();
  await journal.requireSettled();
  await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: false });
  await journal.requireEffectsSettled();
  await assert.rejects(journal.requireSettled(),
    { code: 'RETIREMENT_RELAY_NOT_PAUSED' });
});


test('native retirement protects consumed-origin replacements until recovery',
  async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new RelayJournal(root);
  const current = 'b'.repeat(40);
  const record = { status: 'consumed', runId: 10,
    origin: { repositoryId: 1, runId: 2, attempt: 1 },
    intent: { source: { coreCommit: 'a'.repeat(40) },
      destination: { repositoryId: 20 }, issue: { id: 'I_one', repositoryId: 1 } } };
  record.intent.origin = record.origin;
  await journal.write(record);
  const name = 'replacement-' + digest(record.origin) + '.json';
  const directory = join(root, name.slice(0, -5));
  await mkdir(directory, { mode: 0o700 });
  const operation = new OperationJournal(directory, record.intent.issue);
  const bindingHash = digest({ replacement: 1 });
  const request = { operation: 'wake', bindingHash };
  const native = id => ({ pool: { repositoryId: id }, repositories: [] });
  const settle = binding => settleLifecycleNotifications(binding, false, { root });
  let posts = 0;
  const ports = {
    reconcile: async () => {},
    attempt: async () => ({ id: 10, run_attempt: 1,
      status: 'completed', conclusion: 'failure' }),
    read: () => readRelayState(root, name),
    write: (unused, value) => writeRelayState(root, name, value),
    admit: async () => {}, settle: async () => {},
    dispatch: () => operation.run(request, {
      admit: async () => bindingHash,
      perform: async () => { posts++; return 30; },
      readBack: async () => { throw new Error('response unavailable'); },
    }),
  };
  await withRelayGate(root, () => recoverStaleOrigin(record, current, ports));
  await assert.rejects(settle(native(20)), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  // Source adoption also scopes the effect, even when destination differs.
  await assert.rejects(settle({ pool: { repositoryId: 99 },
    repositories: [{ repositoryId: 1 }] }), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  await settle(native(99));
  assert.deepEqual(await journal.read(record.origin), { schemaVersion: 1, ...record });
  ports.dispatch = assert.fail;
  await operation.recoverWake(bindingHash, async runId => {
    assert.equal(runId, 30);
    return bindingHash;
  });
  // Completed journal evidence still goes through normal association recovery.
  await assert.rejects(settle(native(20)), { code: 'ROLLOUT_REPLACEMENT_PENDING' });
  ports.recover = async () => {
    const result = await operation.recoverWake(bindingHash, async runId => {
      assert.equal(runId, 30);
      return bindingHash;
    });
    return { status: result.status === 'completed' ? 'scheduled' : 'pending',
      runId: result.runId };
  };
  await withRelayGate(root, () => recoverStaleOrigin(record, current, ports));
  await settle(native(20));
  await settle(native(20));
  assert.equal(posts, 1);
  assert.equal((await readRelayState(root, name)).replacementRunId, 30);
  // Association loss or stale status cannot clear the authoritative pending effect.
  await operation.run({ operation: 'wake', bindingHash: digest({ replacement: 2 }) }, {
    admit: async () => digest({ replacement: 2 }),
    perform: async () => 31,
    readBack: async () => { throw new Error('lost readback response'); },
  });
  await assert.rejects(settle(native(20)), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  await settle(native(99));
  await rm(join(root, name));
  await assert.rejects(journal.requireEffectsSettled(),
    { code: 'ROLLOUT_REPLACEMENT_PENDING' });
  await assert.rejects(settle(native(20)), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  await settle(native(99));
  await operation.recoverWake(digest({ replacement: 2 }), async runId => {
    assert.equal(runId, 31);
    return digest({ replacement: 2 });
  });
  await settle(native(20));
  await settle(native(20));
  assert.equal(posts, 1);
  await operation.run({ operation: 'wake', bindingHash: digest({ replacement: 3 }) }, {
    admit: async () => digest({ replacement: 3 }),
    perform: async () => { throw new Error('lost POST response'); },
    readBack: assert.fail,
  });
  await assert.rejects(settle(native(20)), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  await settle(native(99));
  await rm(join(root, 'origin-1-2-1.json'));
  await assert.rejects(settle(native(99)), { code: 'ROLLOUT_REPLACEMENT_PENDING' });
});
