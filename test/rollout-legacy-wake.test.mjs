import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal, readWakeOrigins, requireWakeEffectsSettled }
  from '../src/operation-journal.mjs';
import { recoverLegacyWakeOrigins, requireLegacyReplacementsSettled }
  from '../src/rollout-legacy-wake.mjs';
import { writeRelayState, withRelayGate, RelayJournal } from '../src/relay-state.mjs';
import { withPoolAndDispatchGate } from '../src/rollout-gates.mjs';

const old = 'a'.repeat(40), current = 'b'.repeat(40);
async function fixture(t, observation = true) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-legacy-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = { issue: { id: 'I_old', repositoryId: 1,
    repository: 'example/core', number: 2 }, coreCommit: old,
    workflow: { id: 3, path: '.github/workflows/nibfin-wake.yml',
      commit: old, ref: 'main' }, actorId: 4 };
  const journal = new OperationJournal(root, initial.issue);
  const bindingHash = digest(initial);
  await journal.run({ operation: 'wake', bindingHash,
    ...(observation ? { observation: initial } : {}) }, {
    admit: async () => bindingHash, perform: async () => 10,
    readBack: async () => bindingHash,
  });
  const path = join(root, digest({ issueId: 'I_old', repositoryId: 1 }),
    'receipts.json');
  const before = await readFile(path, 'utf8');
  const run = { id: 10, run_attempt: 1, status: 'completed', conclusion: 'failure' };
  let association, posts = 0, reads = 0;
  const ports = async receipt => {
    assert.equal(receipt.runId, 10);
    assert.deepEqual(receipt.initial, initial);
    return {
      reconcile: async () => { reads++; }, attempt: async () => run,
      read: async () => association,
      write: async (unused, value) => { association = value; },
      admit: async () => {}, settle: async () => requireWakeEffectsSettled(root),
      dispatch: async () => {
        assert.equal(association.originRunId, 10);
        assert.equal(association.status, 'pending');
        posts++;
        return { status: 'scheduled', runId: 20 };
      },
    };
  };
  return { root, initial, journal, path, before, run, ports,
    counts: () => ({ posts, reads }), association: () => association };
}

test('legacy journal origins recover automatically and preserve the original receipt',
  async t => {
    const f = await fixture(t);
    assert.deepEqual((await readWakeOrigins(f.root))[0].initial, f.initial);
    assert.deepEqual(await f.journal.wakeObservation(), f.initial);
    const poll = () => recoverLegacyWakeOrigins({ root: f.root,
      coreCommit: current, ports: f.ports });
    assert.equal((await poll())[0].runId, 20);
    assert.equal(f.association().originRunId, 10);
    assert.equal(f.association().replacementRunId, 20);
    await poll();
    assert.equal(f.counts().posts, 1);
    assert.equal(await readFile(f.path, 'utf8'), f.before);
  });

test('legacy current pins, successful and active runs do not create replacements',
  async t => {
    for (const condition of ['compatible', 'success', 'queued', 'attempt']) {
      const f = await fixture(t);
      if (condition === 'success') f.run.conclusion = 'success';
      if (condition === 'queued') f.run.status = 'queued';
      if (condition === 'attempt') f.run.run_attempt = 2;
      const result = await recoverLegacyWakeOrigins({ root: f.root,
        coreCommit: condition === 'compatible' ? old : current, ports: f.ports });
      assert.equal(f.counts().posts, 0);
      if (condition === 'attempt') assert.equal(result[0].code, 'ROLLOUT_ORIGIN_CHANGED');
      if (condition === 'queued')
        assert.equal(result[0].code, 'ROLLOUT_ORIGIN_STILL_ACTIVE');
    }
  });

test('legacy pauses and unresolved effects remain pending before replacement intent',
  async t => {
    for (const code of ['ISSUE_PAUSED', 'EXTERNAL_EFFECT_UNKNOWN',
      'CALLER_NOT_FIXED_RECIPE']) {
      const f = await fixture(t);
      const result = await recoverLegacyWakeOrigins({ root: f.root,
        coreCommit: current, ports: async receipt => ({ ...await f.ports(receipt),
          admit: async () => { throw Object.assign(new Error(), { code }); } }) });
      assert.equal(result[0].code, code);
      assert.equal(f.association(), undefined);
      assert.equal(f.counts().posts, 0);
    }
  });

test('legacy replacement readback runs without admission or another POST', async t => {
  const f = await fixture(t);
  const first = async receipt => ({ ...await f.ports(receipt),
    dispatch: async () => ({ status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' }) });
  await recoverLegacyWakeOrigins({ root: f.root, coreCommit: current, ports: first });
  const fail = async () => { throw new Error('Admission remains closed'); };
  const ports = async receipt => ({ ...await f.ports(receipt),
    admit: fail, settle: fail, dispatch: fail,
    recover: async () => ({ status: 'scheduled', runId: 21 }) });
  const result = await recoverLegacyWakeOrigins({ root: f.root,
    coreCommit: current, ports });
  assert.equal(result[0].runId, 21);
  assert.equal(f.association().replacementRunId, 21);
  assert.equal(f.counts().posts, 0);
});

test('older legacy receipts without source evidence remain unchanged and pending',
  async t => {
    const f = await fixture(t, false);
    const result = await recoverLegacyWakeOrigins({ root: f.root, coreCommit: current,
      ports: async () => { throw new Error('Cannot infer source'); } });
    assert.equal(result[0].code, 'LEGACY_WAKE_ORIGIN_EVIDENCE_MISSING');
    assert.equal(await readFile(f.path, 'utf8'), f.before);
  });

test('legacy replacement effects block settlement independently of relay state',
  async t => {
    const f = await fixture(t);
    const name = 'legacy-' + 'c'.repeat(64) + '.json';
    await writeRelayState(f.root, name, { status: 'pending' });
    await assert.rejects(requireLegacyReplacementsSettled(f.root),
      { code: 'ROLLOUT_REPLACEMENT_PENDING' });
    await requireLegacyReplacementsSettled(f.root, name);
    await writeRelayState(f.root, name, { status: 'scheduled' });
    await requireLegacyReplacementsSettled(f.root);
  });

test('native legacy attempt readback rejects changed source, actor and attempt',
  async t => {
    const { observeWakeAttempt } = await import('../src/wakeup.mjs');
    const f = await fixture(t);
    const run = { id: 10, event: 'workflow_dispatch', workflow_id: 3,
      path: f.initial.workflow.path, repository: { id: 1 },
      head_repository: { id: 1 }, head_sha: old, head_branch: 'main',
      actor: { id: 4 }, run_attempt: 1 };
    let observed = run;
    const reader = { get: async path => {
      assert.equal(path, '/repos/example/core/actions/runs/10/attempts/1');
      return observed;
    } };
    assert.deepEqual(await observeWakeAttempt(reader, f.initial, 10), run);
    for (const change of [{ head_sha: current }, { actor: { id: 99 } },
      { run_attempt: 2 }, { workflow_id: 99 }, { repository: { id: 2 } }]) {
      observed = { ...run, ...change };
      await assert.rejects(observeWakeAttempt(reader, f.initial, 10),
        { code: 'DISPATCH_RUN_MISMATCH' });
    }
  });

test('legacy polling is bounded and rotates beyond the first fifty receipts', async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 50; index++) {
    const observation = { ...f.initial, sequence: index };
    const bindingHash = digest(observation);
    await f.journal.run({ operation: 'wake', bindingHash, observation }, {
      admit: async () => bindingHash, perform: async () => index + 10,
      readBack: async () => bindingHash,
    });
  }
  let visits = 0;
  const seen = new Set();
  const ports = async receipt => ({
    reconcile: async () => { visits++; seen.add(receipt.runId); },
    attempt: async () => ({ id: receipt.runId, run_attempt: 1,
      status: 'completed', conclusion: 'success' }),
  });
  await recoverLegacyWakeOrigins({ root: f.root, coreCommit: current, ports });
  assert.equal(visits, 50);
  await recoverLegacyWakeOrigins({ root: f.root, coreCommit: current, ports });
  assert.equal(visits, 100);
  assert.equal(seen.size, 51);
});

test('legacy replacement observation survives an uncertain POST with a large Issue body',
  async t => {
    const f = await fixture(t);
    const observation = { ...f.initial, state: { body: 'x'.repeat(20000) } };
    const bindingHash = digest(observation);
    const result = await f.journal.run({ operation: 'wake', bindingHash, observation }, {
      admit: async () => bindingHash,
      perform: async () => { throw new Error('Lost response'); },
      readBack: async () => { throw new Error('No known native ID'); },
    });
    assert.equal(result.status, 'pending');
    const restarted = new OperationJournal(f.root, f.initial.issue);
    assert.deepEqual(await restarted.wakeObservation(), observation);
    await assert.rejects(requireWakeEffectsSettled(f.root),
      { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  });

test('legacy replacement settles a configured relay while retaining both gates',
  async t => {
    const f = await fixture(t);
    const relayRoot = join(f.root, 'relay'), stateRoot = join(f.root, 'pool');
    await mkdir(relayRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    const host = { uid: process.getuid(), stateRoot };
    const relay = new RelayJournal(relayRoot);
    await writeRelayState(relayRoot, 'control.json', { schemaVersion: 1, paused: false });
    const poll = async () => withPoolAndDispatchGate(host, relayRoot,
      () => recoverLegacyWakeOrigins({ root: f.root, coreCommit: current,
        ports: async receipt => {
          const original = await f.ports(receipt);
          return { ...original,
            settle: async () => {
              await relay.requireEffectsSettledUnderGate();
              await original.settle();
            },
            dispatch: async () => {
              const competing = await withRelayGate(relayRoot, () => assert.fail());
              assert.equal(competing.status, 'pending');
              return original.dispatch();
            },
          };
        } }));
    const origin = { repositoryId: 1, runId: 99, attempt: 1 };
    const intent = { origin };
    await relay.write({ origin, intent, status: 'pending' });
    assert.equal((await poll())[0].code, 'RETIREMENT_RELAY_EFFECT_PENDING');
    assert.equal(f.counts().posts, 0);
    assert.equal(f.association(), undefined);
    await relay.write({ origin, intent, status: 'consumed', runId: 100 });
    const pending = 'replacement-' + 'd'.repeat(64) + '.json';
    await writeRelayState(relayRoot, pending, { status: 'pending' });
    assert.equal((await poll())[0].code, 'ROLLOUT_REPLACEMENT_PENDING');
    assert.equal(f.counts().posts, 0);
    assert.equal(f.association(), undefined);
    await writeRelayState(relayRoot, pending, { status: 'scheduled' });
    assert.equal((await poll())[0].runId, 20);
    await poll();
    assert.equal(f.counts().posts, 1);
    assert.equal(await readFile(f.path, 'utf8'), f.before);
    assert.equal((await relay.control()).paused, false);
    await relay.requireEffectsSettled();
    await writeRelayState(relayRoot, 'control.json', { schemaVersion: 1, paused: true });
    await relay.requireSettled();
  });

test('timer preserves validated Controller ownership in controlled identity inputs',
  async t => {
    const fs = await import('node:fs/promises');
    const uid = 23456;
    let identity = uid;
    const owners = new Map();
    const lstat = fs.default.lstat, open = fs.default.open;
    t.mock.method(process, 'getuid', () => identity);
    t.mock.method(fs.default, 'lstat', async (...args) => {
      const stat = await lstat(...args);
      stat.uid = owners.get(String(args[0])) ?? uid;
      return stat;
    });
    t.mock.method(fs.default, 'open', async (...args) => {
      const handle = await open(...args), stat = handle.stat.bind(handle);
      handle.stat = async (...options) => {
        const value = await stat(...options);
        value.uid = owners.get(String(args[0])) ?? uid;
        return value;
      };
      handle.chown = async owner => { owners.set(String(args[0]), owner); };
      return handle;
    });
    const { syncBuiltinESMExports } = await import('node:module');
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const f = await fixture(t);
    identity = 0; // Timer, distinct from the Controller owning the receipts.
    await assert.rejects(readWakeOrigins(f.root),
      { code: 'UNTRUSTED_JOURNAL_DIRECTORY' });
    await assert.rejects(readWakeOrigins(f.root, uid + 1),
      { code: 'UNTRUSTED_JOURNAL_DIRECTORY' });
    assert.equal((await readWakeOrigins(f.root, uid)).length, 1);
    const journal = new OperationJournal(f.root, f.initial.issue, { uid });
    await journal.assertIdle();
    await requireWakeEffectsSettled(f.root, uid);
    const name = 'legacy-' + 'f'.repeat(64) + '.json';
    await writeRelayState(f.root, name, { status: 'pending' }, uid);
    await assert.rejects(requireLegacyReplacementsSettled(f.root, undefined, uid),
      { code: 'ROLLOUT_REPLACEMENT_PENDING' });
    await writeRelayState(f.root, name, { status: 'scheduled' }, uid);
    await requireLegacyReplacementsSettled(f.root, undefined, uid);
    const results = await recoverLegacyWakeOrigins({
      root: f.root, uid, coreCommit: current,
      ports: async receipt => ({ ...await f.ports(receipt),
        settle: () => requireWakeEffectsSettled(f.root, uid) }),
    });
    assert.equal(results[0].runId, 20);
    const bindingHash = digest({ replacement: true });
    await journal.run({ operation: 'wake', bindingHash }, {
      admit: async () => bindingHash, perform: async () => 30,
      readBack: async () => bindingHash,
    });
    assert.ok([...owners.values()].every(owner => owner === uid));
    identity = uid;
    await requireWakeEffectsSettled(f.root);
    assert.equal((await readWakeOrigins(f.root)).length, 2);
    identity = uid + 1;
    assert.throws(() => new OperationJournal(f.root, f.initial.issue, { uid }),
      { code: 'UNTRUSTED_JOURNAL_OWNER' });
  });
