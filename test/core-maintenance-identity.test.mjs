import assert from 'node:assert/strict';
import test from 'node:test';
import { jobCheckRunId, assignedNativeJob } from '../src/native-job-check.mjs';
import { coreMaintenanceContract } from '../src/core-maintenance-contract.mjs';
import { admitCoreMaintenance, requireCoreMaintenance, isOwnMaintenanceJob }
  from '../src/core-maintenance-identity.mjs';
import { providerHost } from './provider-fixture.mjs';

test('check identity follows native check_run_url independently of Job ID', () => {
  const job = { id: 123,
    check_run_url: 'https://api.github.com/repos/example/core/check-runs/456' };
  assert.equal(jobCheckRunId(job, 'example/core'), 456);
  for (const url of [undefined, 'https://example.com/check-runs/456',
    job.check_run_url + '?extra=1', job.check_run_url.replace('/456', '/0'),
    job.check_run_url.replace('example/core', 'example/other')]) {
    assert.throws(() => jobCheckRunId({ ...job, check_run_url: url }, 'example/core'),
      { code: 'JOB_CHECK_IDENTITY_REQUIRED' });
  }
});

test('ordinary object and claimed job cannot mint maintenance authority', async () => {
  const request = { runId: 123, attempt: 1, jobId: 456, runnerId: 42,
    target: { runId: 789, artifactId: 321 }, token: 'not-a-signed-token' };
  for (const context of [{}, { admitted: true }, { mode: 'core-only' }]) {
    await assert.rejects(admitCoreMaintenance(context, providerHost(), request, 91,
      { get: () => { throw new Error('must not read'); } }),
    { code: 'ROLLOUT_MANAGER_NOT_ADMITTED' });
    assert.throws(() => requireCoreMaintenance({ nativeJob: request }, context),
      { code: 'CORE_MAINTENANCE_NOT_ADMITTED' });
    assert.throws(() => isOwnMaintenanceJob({}, context, 'example/core', {}, {}),
      { code: 'CORE_MAINTENANCE_NOT_ADMITTED' });
  }
});

test('maintenance contract has one fixed purpose and native event', () => {
  assert.equal(coreMaintenanceContract.mode, 'core-only');
  assert.equal(coreMaintenanceContract.eventName, 'workflow_dispatch');
  assert.equal(coreMaintenanceContract.workflowPath,
    '.github/workflows/core-maintenance.yml');
  assert(Object.isFrozen(coreMaintenanceContract));
});

test('native GUID resolves assigned Job across official pages, not Check Run ID',
  async () => {
    const expected = { repository: 'example/core', runId: 123, attempt: 2,
      sourceCommit: 'a'.repeat(40), runnerId: 42, runnerName: 'slot-1',
      jobName: 'core-maintenance' };
    const guid = '12345678-1234-1234-1234-123456789abc';
    const job = { id: 456, run_id: 123, run_attempt: 2, head_sha: expected.sourceCommit,
      runner_id: 42, runner_name: 'slot-1', name: expected.jobName,
      status: 'in_progress', conclusion: null,
      check_run_url: 'https://api.github.com/repos/example/core/check-runs/999' };
    const other = { ...job, id: 455, runner_id: 43, runner_name: 'slot-2' };
    const reader = { get: async path => {
      if (path.endsWith('page=1')) return { total_count: 2, jobs: [other] };
      if (path.endsWith('page=2')) return { total_count: 2, jobs: [job] };
      assert.equal(path, '/repos/example/core/check-runs/999');
      return { id: 999, head_sha: expected.sourceCommit, app: { slug: 'github-actions' },
        name: expected.jobName, status: 'in_progress', conclusion: null,
        external_id: guid.toUpperCase() };
    } };
    assert.deepEqual(await assignedNativeJob(reader, expected, guid), job);
    await assert.rejects(assignedNativeJob(reader, expected,
      guid.replace('12345678', 'aaaaaaaa')),
    { code: 'SHARED_WORKER_JOB_IDENTITY_MISMATCH' });
    const duplicate = { get: async () => ({ total_count: 2, jobs: [job, job] }) };
    await assert.rejects(assignedNativeJob(duplicate, expected, guid),
      { code: 'NATIVE_JOB_LIST_CHANGED' });
  });
