import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { providerHost } from './provider-fixture.mjs';
import { continuationLifecycle, ContinuationState } from '../src/continuation-state.mjs';
import { resumeInstalledWork, pendingInstalledContinuation } from
  '../src/rollout-resume.mjs';
import { pollNotificationRelay } from '../src/relay-service.mjs';
import { writeRelayState } from '../src/relay-state.mjs';

async function fixture(t) {
  // Private, canonical repository-local paths; no installed host or credentials.
  const root = await mkdtemp(join(resolve('.'), '.continuation-recovery-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = providerHost();
  host.stateRoot = root;
  const stateRoot = join(root, 'lifecycle-continuation');
  const origins = [{ repositoryId: 1, repository: 'example/pool' }];
  const pool = continuationLifecycle(host, origins, null, null).pool;
  const retirement = { id: 'released-before-response', phase: 'retired',
    replacement: { phase: 'released', activationVerified: true, pool } };
  let reads = 0;
  let unavailable = false;
  const context = { host, journal: { root, control: async () => ({ paused: false }) },
    configuration: { memberId: host.memberId, origins },
    inspect: async () => {}, reader: {
      get: async () => ({ id: host.memberId, login: 'owner', type: 'User' }),
      list: async () => {
        reads++;
        if (unavailable) throw new Error('temporary list failure');
        return [];
      },
    } };
  return { root: stateRoot, context, retirement, reads: () => reads,
    fail: value => { unavailable = value; },
    options: { load: async options => {
      assert.deepEqual(options, { verifyRemote: false });
      return context;
    }, requireAdmission: async () => {},
    read: async path => path.endsWith('managed-retirement.json') ? retirement : null,
    fetcher: async () => assert.fail('empty scan must not POST') } };
}

test('explicit completion discovers released activation without a receipt', async t => {
  const f = await fixture(t);
  const output = [];
  const original = console.log;
  console.log = (...args) => output.push(args);
  try {
    assert.equal((await resumeInstalledWork(f.options)).status, 'dispatched');
    const record = await new ContinuationState(f.root).read();
    assert.equal(record.lifecycle.retirementId, f.retirement.id);
    await resumeInstalledWork(f.options);
    assert.equal(f.reads(), 2);
  } finally { console.log = original; }
  assert.deepEqual(output, []);
});

test('notification polling never initiates lifecycle completion', async t => {
  const f = await fixture(t);
  const notifications = { status: 'observed', results: [], stageAdmitted: false };
  const result = await pollNotificationRelay({
    load: async () => ({ journal: f.context.journal }),
    poll: async () => notifications,
    recover: async () => [],
    resume: async () => assert.fail('notification polling must not resume work'),
  });
  assert.deepEqual(result, { ...notifications, recovery: [] });
  assert.equal(f.reads(), 0);
  await assert.rejects(pollNotificationRelay({
    load: async () => { throw new Error('old origin unavailable'); },
  }), /old origin unavailable/);
  assert.equal((await resumeInstalledWork(f.options)).status, 'dispatched');
});

test('failed lists remain pending and explicit retry observes again', async t => {
  const f = await fixture(t);
  f.fail(true);
  assert.equal((await pendingInstalledContinuation(f.options)).status, 'pending');
  assert.equal((await new ContinuationState(f.root).read()).status, 'pending');
  f.fail(false);
  assert.equal((await resumeInstalledWork(f.options)).status, 'dispatched');
  assert.equal(f.reads(), 2);
});

test('old relay pause is irrelevant and unresolved drain cannot complete', async t => {
  const f = await fixture(t);
  await writeRelayState(f.context.host.stateRoot, 'control.json',
    { schemaVersion: 1, paused: true });
  f.context.journal.control = async () => ({ paused: true });
  assert.equal((await resumeInstalledWork(f.options)).status, 'dispatched');
  const result = await pendingInstalledContinuation({ ...f.options,
    read: async path => path.endsWith('managed-pool-drain.json') ? {} : f.retirement });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'MANAGED_POOL_RETIRING');
  assert.equal(f.reads(), 1);
});

test('identity observation failure stays retryable and never claims absence', async t => {
  const f = await fixture(t);
  const get = f.context.reader.get;
  f.context.reader.get = async () => { throw new Error('identity unavailable'); };
  assert.equal((await pendingInstalledContinuation(f.options)).status, 'pending');
  assert.equal(f.reads(), 0);
  f.context.reader.get = get;
  assert.equal((await resumeInstalledWork(f.options)).status, 'dispatched');
  assert.equal(f.reads(), 1);
});
