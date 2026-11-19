import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireNoRollout, rolloutMarker, validateListenerRollout }
  from '../src/rollout-admission.mjs';
import { withPoolAndDispatchGate } from '../src/rollout-gates.mjs';
import { poolAdmission, requirePoolConsumersSettled }
  from '../src/retirement-admission.mjs';
import { withRelayGate, writeRelayState, RelayJournal } from '../src/relay-state.mjs';
import { assertRetirementJobs } from '../src/retirement-observe.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rollout-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state'), relayRoot = join(root, 'relay');
  for (const path of [stateRoot, relayRoot]) await mkdir(path, { mode: 0o700 });
  const marker = join(root, 'rollout.json');
  return { host: { uid: process.getuid(), stateRoot }, relayRoot, marker };
}

test('rollout closure preserves leases and the operator relay pause', async t => {
  const f = await fixture(t);
  const relay = new RelayJournal(f.relayRoot);
  await writeRelayState(f.relayRoot, 'control.json', { schemaVersion: 1, paused: true });
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const operation = poolAdmission(f.host, async () => {
    entered(); await held;
  }, f.marker);
  await started;
  await withPoolAndDispatchGate(f.host, f.relayRoot,
    () => writeFile(f.marker, '{}'));
  await assert.rejects(requireNoRollout(f.marker),
    { code: 'MANAGED_POOL_ROLLOUT_PENDING' });
  await assert.rejects(poolAdmission(f.host, async () => assert.fail(), f.marker));
  await assert.rejects(requirePoolConsumersSettled(f.host));
  finish(); await operation;
  await requirePoolConsumersSettled(f.host);
  await relay.requireEffectsSettled();
  assert.equal((await relay.control()).paused, true);
  await rm(f.marker);
  await requireNoRollout(f.marker);
  await rm(join(f.relayRoot, 'control.json'));
  await symlink(join(f.relayRoot, 'missing'), f.marker);
  await assert.rejects(requireNoRollout(f.marker));
});

test('in-flight relay dispatch prevents closure from crossing its admission gate',
  async t => {
    const f = await fixture(t);
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    const dispatch = withRelayGate(f.relayRoot, async () => { entered(); await held; });
    await started;
    let published = false;
    const result = await withPoolAndDispatchGate(f.host, f.relayRoot,
      async () => { published = true; });
    assert.equal(result.status, 'pending');
    assert.equal(published, false);
    finish(); await dispatch;
    await withPoolAndDispatchGate(f.host, f.relayRoot, async () => { published = true; });
    assert.equal(published, true);
  });

test('only native Jobs assigned to the bound pool block drain', async () => {
  const repositories = [{ repository: 'owner/project', repositoryId: 1 }];
  const pool = { runners: [{ id: 7, name: 'first' }, { id: 8, name: 'second' }] };
  let jobs = [{ status: 'queued', runner_id: null, runner_name: '' }];
  const reader = {
    get: async () => ({ id: 1, full_name: 'owner/project' }),
    list: async path => {
      if (path.endsWith('/jobs')) return jobs;
      assert(path.endsWith('status=in_progress'));
      return [{ id: 10 }];
    },
  };
  await assertRetirementJobs(reader, repositories, pool);
  for (const assignment of [{ runner_id: 7 }, { runner_name: 'second' }]) {
    jobs = [{ status: 'in_progress', ...assignment }];
    await assert.rejects(assertRetirementJobs(reader, repositories, pool),
      { code: 'RETIREMENT_JOB_PENDING' });
  }
  jobs = [{ status: 'completed', runner_id: 7 }];
  await assertRetirementJobs(reader, repositories, pool);
});


test('listener readiness permits only the verified target under its own closure', () => {
  const pin = { commit: 'a'.repeat(40) };
  const host = { installation: { pin } };
  const plan = { schemaVersion: 2, phase: 'verifying', pin,
    binding: { pool: { runners: [1, 2] } }, apply: { completed: true } };
  const marker = rolloutMarker(plan);
  validateListenerRollout(host, plan, marker);
  for (const change of [
    value => { value.phase = 'draining'; },
    value => { value.apply.completed = false; },
    value => { value.pin.commit = 'b'.repeat(40); },
    value => { value.binding.pool.runners = [3, 4]; },
  ]) {
    const wrong = structuredClone(plan); change(wrong);
    assert.throws(() => validateListenerRollout(host, wrong, marker),
      { code: 'ROLLOUT_LISTENER_NOT_READY' });
  }
});
