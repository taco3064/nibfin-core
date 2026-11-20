import { hostMemoryPressure, pressureStages } from '../src/host-memory-pressure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, retrySharedRunner } from '../scripts/retry-shared-runner.mjs';
import { writerPressureWait } from '../src/job-vm-pressure.mjs';

test('Writer memory pressure retries only a settled Deliver continuation', () => {
  const result = {
    schemaVersion: 1, stage: 'continue', terminalStage: 'deliver', status: 'denied',
    code: writerPressureWait, retrySettled: true, retryRun: 2, retryAttempt: 1,
  };
  assert.equal(retryDelay(JSON.stringify(result), 2, 1), 300_000);
  assert.equal(retryDelay(JSON.stringify({ ...result, retrySettled: false }), 2, 1),
    null);
  assert.equal(retryDelay(JSON.stringify({ ...result, terminalStage: 'accept' }), 2, 1),
    null);
});

const repository = { id: 1, full_name: 'taco3064/nibfin-core', default_branch: 'main' };
const run = {
  id: 2, run_attempt: 1, repository, head_repository: repository,
  head_branch: 'main', path: '.github/workflows/shared-runner.yml',
  status: 'completed', conclusion: 'failure', event: 'workflow_dispatch',
  actor: { id: 3 },
};
const marker = '2026-11-13T00:00:00Z ' + JSON.stringify({
  schemaVersion: 1, status: 'pending', code: 'GITHUB_READ_RETRY_PENDING',
  stage: 'continue', retrySettled: true, retryRun: 2, retryAttempt: 1,
  retryAfterMs: 60000,
});

test('retry marker binds the settled result to this run and attempt', () => {
  assert.equal(retryDelay(marker, 2, 1), 60000);
  assert.equal(retryDelay(marker, 2, 2), null);
  assert.equal(retryDelay(marker + '\n' + marker, 2, 1), null);
  assert.equal(retryDelay(marker.replace('60000', '3600000'), 2, 1), 3600000);
  assert.equal(retryDelay(marker.replace('60000', '3660001'), 2, 1), null);
});

test('a settled GitHub API failure uses a separate delayed attempt', () => {
  const result = { schemaVersion: 1, stage: 'continue', terminalStage: 'publish-shape',
    code: 'GITHUB_API_RETRY_PENDING', status: 'pending', retryAfterMs: 60000,
    retrySettled: true, retryRun: 2, retryAttempt: 1 };
  assert.equal(retryDelay(JSON.stringify(result), 2, 1), 60000);
  assert.equal(retryDelay(JSON.stringify({ ...result, retrySettled: false }), 2, 1),
    null);
  const unqualified = { ...result, code: 'LIVE_OBSERVATION_HTTP_422' };
  assert.equal(retryDelay(JSON.stringify(unqualified), 2, 1), null);
});

test('only settled and matching CI continuations receive a new attempt', () => {
  const result = { schemaVersion: 1, status: 'pending', stage: 'continue',
    terminalStage: 'deliver', retrySettled: true, retryRun: 2, retryAttempt: 1 };
  for (const code of ['CI_WAITING', 'CI_FAILURE_LOG_WAITING',
    'CI_CORRECTION_RETRY_PENDING']) {
    assert.equal(retryDelay(JSON.stringify({ ...result, code }), 2, 1), 60000);
    assert.equal(retryDelay(JSON.stringify({ ...result, code, retrySettled: false }),
      2, 1), null);
  }
  const code = 'CONTROLLER_HANDOFF_UNRESOLVED';
  assert.equal(retryDelay(JSON.stringify({ ...result, code }), 2, 1), null);
  assert.equal(retryDelay(JSON.stringify({ ...result, code: 'CI_CORRECTION_RETRY_PENDING',
    terminalStage: 'accept' }), 2, 1), null);
});
test('a settled failure retries once and skips an already resumed attempt', async () => {
  for (const moved of [false, true]) {
    let current = { ...run };
    const reader = {
      get: async path => path === '/user' ? run.actor : current,
      list: async () => [{
        id: 4, name: 'shared-stage', conclusion: 'failure', status: 'completed',
        run_id: 2, run_attempt: 1,
      }],
    };
    let reruns = 0;
    const result = await retrySharedRunner(reader, { repository, workflow_run: run }, {
      logs: async () => marker,
      rerun: async id => { assert.equal(id, 2); reruns++; },
      wait: async delay => {
        assert.equal(delay, 60000);
        if (moved) current = { ...run, run_attempt: 2 };
      },
    });
    assert.equal(result, !moved);
    assert.equal(reruns, moved ? 0 : 1);
  }
});

test('settled admitted-stage pressure uses the bounded delayed rerun route', async () => {
  for (const terminalStage of pressureStages) {
    const result = { schemaVersion: 1, stage: 'continue', terminalStage,
      code: hostMemoryPressure, pressureConfirmed: true, status: 'denied',
      retrySettled: true, retryRun: 2, retryAttempt: 1 };
    const log = JSON.stringify(result);
    assert.equal(retryDelay(log, 2, 1), 300_000);
    assert.equal(retryDelay(log, 2, 2), null);
    assert.equal(retryDelay(log + '\n' + log, 2, 1), null);
    for (const patch of [{ retrySettled: false }, { pressureConfirmed: false },
      { terminalStage: 'merge' }, { status: 'pending' }])
      assert.equal(retryDelay(JSON.stringify({ ...result, ...patch }), 2, 1), null);
    let current = { ...run }, reruns = 0;
    const reader = { get: async path => path === '/user' ? run.actor : current,
      list: async () => [{ id: 4, name: 'shared-stage', conclusion: 'failure',
        status: 'completed', run_id: 2, run_attempt: 1 }] };
    const options = { logs: async () => log, wait: async delay => {
      assert.equal(delay, 300_000);
    }, rerun: async () => { reruns++; current = { ...run, run_attempt: 2 }; } };
    assert.equal(await retrySharedRunner(reader, { repository, workflow_run: run },
      options), true);
    assert.equal(await retrySharedRunner(reader, { repository, workflow_run: run },
      options), false);
    assert.equal(reruns, 1);
    assert.equal(await retrySharedRunner(reader, { repository,
      workflow_run: { ...run, run_attempt: 3 } }, options), false);
  }
});


test('settled local interruption uses the existing rerun route without a new delay',
  async () => {
    const result = { schemaVersion: 1, stage: 'continue', terminalStage: 'deliver',
      status: 'pending', code: 'LOCAL_DELIVER_INTERRUPTED', retrySettled: true,
      retryRun: 2, retryAttempt: 1 };
    const log = value => JSON.stringify(value);
    assert.equal(retryDelay(log(result), 2, 1), 0);
    for (const changed of [{ retrySettled: false }, { retryRun: 3 },
      { retryAttempt: 2 }, { terminalStage: 'accept' }, { stage: 'deliver' },
      { status: 'denied' }])
      assert.equal(retryDelay(log({ ...result, ...changed }), 2, 1), null);
    const calls = [];
    const reader = { get: async () => run, list: async () => [{
      id: 4, name: 'shared-stage', conclusion: 'failure', status: 'completed',
      run_id: 2, run_attempt: 1,
    }] };
    assert.equal(await retrySharedRunner(reader, { repository, workflow_run: run }, {
      logs: async () => log(result), actorRead: async () => run.actor,
      wait: async delay => { calls.push(delay); },
      rerun: async id => { calls.push(id); },
    }), true);
    assert.deepEqual(calls, [0, 2]);
  });
