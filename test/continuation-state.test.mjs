import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { continuationLifecycle, ContinuationState, resumeLifecycle } from
  '../src/continuation-state.mjs';
import { providerHost } from './provider-fixture.mjs';

const origins = [{ repositoryId: 1, repository: 'example/pool' }];
const lifecycle = (host = providerHost(), retirement = null, drain = null) =>
  continuationLifecycle(host, origins, retirement, drain);

async function fixture(t) {
  const root = await mkdtemp(join(resolve('.'), '.continuation-test-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ContinuationState(root);
}

test('same package with fresh Runner IDs starts a new lifecycle', async t => {
  const state = await fixture(t);
  const host = providerHost();
  let scans = 0;
  const run = () => resumeLifecycle({ lifecycle: lifecycle(host), state,
    inspect: async () => {}, resume: async () => {
      scans++;
      return { status: 'dispatched', results: [] };
    } });
  await run();
  await run();
  assert.equal(scans, 2);
  host.sharedRunner.runner.runnerId = 44;
  host.sharedRunner.additionalRunner.id = 45;
  await run();
  assert.equal(scans, 3);
  assert.equal((await state.read()).lifecycle.pool.runners[0].id, 44);
});

test('only verified release with no drain is eligible', () => {
  const current = lifecycle();
  const retired = { id: 'replacement', phase: 'retired',
    replacement: { phase: 'released', activationVerified: true, pool: current.pool } };
  assert.equal(lifecycle(providerHost(), retired).retirementId, 'replacement');
  for (const phase of ['publishing', 'prepared']) {
    assert.throws(() => lifecycle(providerHost(), { ...retired,
      replacement: { ...retired.replacement, phase } }),
    { code: 'MANAGED_POOL_RETIREMENT_UNRESOLVED' });
  }
  assert.throws(() => lifecycle(providerHost(), retired, {}),
    { code: 'MANAGED_POOL_RETIRING' });
  assert.throws(() => lifecycle(providerHost(), { ...retired,
    replacement: { ...retired.replacement, activationVerified: false } }),
  { code: 'MANAGED_POOL_RETIREMENT_UNRESOLVED' });
  const changed = providerHost();
  changed.sharedRunner.runner.runnerId = 46;
  assert.throws(() => lifecycle(changed, retired),
    { code: 'MANAGED_POOL_RETIREMENT_UNRESOLVED' });
});

test('response loss and partial progress resume without a local completion', async t => {
  const state = await fixture(t);
  const done = { repositoryId: 1, number: 1, id: 'I_1', runId: 9 };
  const context = { lifecycle: lifecycle(), state, inspect: async () => {} };
  await assert.rejects(resumeLifecycle({ ...context,
    resume: async ({ completed, onDispatched }) => {
      assert.deepEqual(completed, []);
      await onDispatched(done);
      throw new Error('identity observation unavailable');
    } }), /observation unavailable/);
  assert.equal((await state.read()).status, 'pending');
  await resumeLifecycle({ ...context, resume: async ({ completed }) => {
    assert.deepEqual(completed, [done]);
    return { status: 'paused', results: [] };
  } });
  assert.equal((await state.read()).status, 'paused');
  await rm(join(state.root, 'continuation.json'));
  await resumeLifecycle({ ...context, resume: async ({ completed }) => {
    assert.deepEqual(completed, [done]);
    return { status: 'dispatched', results: [] };
  } });
});

test('unbound legacy completion cannot suppress a scan', async t => {
  const state = await fixture(t);
  await state.write({ installation: providerHost().installation,
    completed: [{ id: 'I_1' }], status: 'dispatched' });
  let scanned = false;
  await resumeLifecycle({ lifecycle: lifecycle(), state, inspect: async () => {},
    resume: async ({ completed }) => {
      scanned = true;
      assert.deepEqual(completed, []);
      return { status: 'pending', results: [] };
    } });
  assert.equal(scanned, true);
});

test('failed current-state observation never reuses a completed lifecycle', async t => {
  const state = await fixture(t);
  await state.write({ schemaVersion: 1, lifecycle: lifecycle(),
    completed: [], status: 'dispatched' });
  await assert.rejects(resumeLifecycle({ lifecycle: lifecycle(), state,
    inspect: async () => { throw new Error('adoption unavailable'); },
    resume: async () => assert.fail('must observe current adoption first'),
  }), /adoption unavailable/);
});


test('growing scans keep independent receipts and recover missing progress', async t => {
  const state = await fixture(t);
  const context = { lifecycle: lifecycle(), state, inspect: async () => {} };
  await resumeLifecycle({ ...context, resume: async ({ onDispatched }) => {
    for (let number = 1; number <= 100; number++) await onDispatched({
      repositoryId: 1, number, id: `I_${number}`, runId: number,
      url: 'https://github.com/example/pool/actions/runs/' + number,
    });
    return { status: 'dispatched', results: [] };
  } });
  assert.equal((await state.read()).completed.length, 100);
  await rm(join(state.root, 'continuation-1-50.json'));
  await resumeLifecycle({ ...context, resume: async ({ completed }) => {
    assert.equal(completed.length, 99);
    assert.ok(!completed.some(item => item.number === 50));
    return { status: 'pending', results: [] };
  } });
  const host = providerHost();
  host.sharedRunner.runner.runnerId = 60;
  await resumeLifecycle({ ...context, lifecycle: lifecycle(host),
    resume: async ({ completed }) => {
      assert.deepEqual(completed, []);
      return { status: 'dispatched', results: [] };
    } });
  assert.ok(!(await readdir(state.root)).some(name => /^continuation-/.test(name)));
});

test('malformed observational records cannot suppress discovery', async t => {
  const state = await fixture(t);
  await writeFile(join(state.root, 'continuation.json'), '{', { mode: 0o600 });
  await writeFile(join(state.root, 'continuation-1-1.json'), 'null', { mode: 0o600 });
  let scans = 0;
  await resumeLifecycle({ lifecycle: lifecycle(), state, inspect: async () => {},
    resume: async ({ completed }) => {
      scans++;
      assert.deepEqual(completed, []);
      return { status: 'dispatched', results: [] };
    } });
  assert.equal(scans, 1);
});
