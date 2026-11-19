import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStaleOrigin } from '../src/rollout-recovery.mjs';

function fixture() {
  const record = { status: 'consumed', runId: 10,
    origin: { repositoryId: 1, runId: 2, attempt: 1 },
    intent: { source: { coreCommit: 'a'.repeat(40) } } };
  let saved, posts = 0, admitted = 0, settled = 0;
  const run = { id: 10, run_attempt: 1, status: 'completed', conclusion: 'failure' };
  const ports = {
    reconcile: async () => {}, attempt: async () => run,
    read: async () => saved,
    write: async (unused, value) => { saved = value; },
    admit: async () => { admitted++; }, settle: async () => { settled++; },
    dispatch: async () => {
      assert.equal(saved.status, 'pending'); posts++;
      return { status: 'scheduled', runId: 20 };
    },
  };
  return { record, run, ports, counts: () => ({ posts, admitted, settled }),
    saved: () => saved };
}
const current = 'b'.repeat(40);

test('stale recovery preserves the origin and journals a current-source replacement',
  async () => {
    const f = fixture(), before = structuredClone(f.record);
    assert.equal((await recoverStaleOrigin(f.record, current, f.ports)).runId, 20);
    assert.deepEqual(f.record, before);
    assert.deepEqual(f.counts(), { posts: 1, admitted: 1, settled: 1 });
    assert.equal(f.saved().originRunId, 10);
    assert.equal(f.saved().replacementRunId, 20);
    await recoverStaleOrigin(f.record, current, f.ports);
    assert.equal(f.counts().posts, 1);
  });

test('compatible, successful, active and ambiguous origins never dispatch', async () => {
  for (const condition of ['compatible', 'success', 'active', 'ambiguous']) {
    const f = fixture();
    if (condition === 'compatible') f.record.intent.source.coreCommit = current;
    if (condition === 'success') f.run.conclusion = 'success';
    if (condition === 'active') f.run.status = 'queued';
    if (condition === 'ambiguous') f.ports.reconcile = async () => {
      throw Object.assign(new Error(), { code: 'RELAY_RUN_READBACK_UNKNOWN' });
    };
    try { await recoverStaleOrigin(f.record, current, f.ports); }
    catch (error) { assert.equal(error.code, 'RELAY_RUN_READBACK_UNKNOWN'); }
    assert.equal(f.counts().posts, 0);
  }
});

test('pause, unresolved work and changed attempts prevent replacements', async () => {
  for (const step of ['admit', 'settle', 'attempt']) {
    const f = fixture();
    if (step === 'attempt') f.run.run_attempt = 2;
    else f.ports[step] = async () => { throw new Error(step); };
    await assert.rejects(recoverStaleOrigin(f.record, current, f.ports));
    assert.equal(f.counts().posts, 0);
    assert.equal(f.saved(), undefined);
  }
});

test('uncertain replacement retains its source and journal', async () => {
  const f = fixture();
  f.ports.dispatch = async () =>
    ({ status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' });
  assert.equal((await recoverStaleOrigin(f.record, current, f.ports)).status, 'pending');
  await assert.rejects(recoverStaleOrigin(f.record, 'c'.repeat(40), f.ports),
    { code: 'ROLLOUT_REPLACEMENT_SOURCE_CHANGED' });
  assert.equal(f.saved().status, 'pending');
});

test('pending replacement readback bypasses closed admission and settlement',
  async () => {
    const f = fixture(), before = structuredClone(f.record);
    f.ports.dispatch = async () =>
      ({ status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' });
    await recoverStaleOrigin(f.record, current, f.ports);
    const counts = f.counts();
    f.ports.admit = async () => { throw new Error('MANAGED_POOL_ROLLOUT_PENDING'); };
    f.ports.settle = async () => { throw new Error('ROLLOUT_REPLACEMENT_PENDING'); };
    f.ports.dispatch = async () => { throw new Error('Must never POST'); };
    f.ports.recover = async () =>
      ({ status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' });
    const pending = await recoverStaleOrigin(f.record, current, f.ports);
    assert.equal(pending.status, 'pending');
    assert.equal(f.saved().status, 'pending');
    f.ports.recover = async () => ({ status: 'scheduled', runId: 20 });
    assert.equal((await recoverStaleOrigin(f.record, current, f.ports)).runId, 20);
    assert.equal(f.saved().replacementRunId, 20);
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(f.record, before);
  });
