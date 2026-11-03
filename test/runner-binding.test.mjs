import test from 'node:test';
import assert from 'node:assert/strict';
import { gitBlob } from '../src/identity.mjs';
import { readRunnerBinding } from '../src/runner-binding.mjs';

function fixture() {
  const body = '# Synthetic pinned workflow source\n';
  const member = { id: 2, login: 'member', type: 'User' }, actor = { id: 3, login: 'publisher', type: 'User' };
  const expected = { repository: 'example/core', repositoryId: 10, runId: 20, attempt: 1, jobId: 30,
    runnerId: 40, memberId: 2, actorId: 3, workflowId: 50, sourceCommit: 'a'.repeat(40),
    workflowBlob: gitBlob(body), runnerName: 'member-linux', jobName: 'execute',
    workflowPath: '.github/workflows/execute.yml', member };
  const repository = { id: 10, full_name: 'example/core', private: false, archived: false, disabled: false, default_branch: 'main' };
  const run = { id: 20, run_attempt: 1, status: 'in_progress', conclusion: null, event: 'workflow_dispatch',
    repository, head_repository: repository, head_branch: 'main', head_sha: expected.sourceCommit,
    path: expected.workflowPath, workflow_id: 50, actor, triggering_actor: actor, pull_requests: [], referenced_workflows: [] };
  const job = { id: 30, run_id: 20, run_attempt: 1, status: 'in_progress', conclusion: null,
    head_sha: expected.sourceCommit, name: 'execute', runner_id: 40, runner_name: 'member-linux', labels: ['self-hosted', 'nibfin-user-2'] };
  const runner = { id: 40, name: 'member-linux', os: 'linux', status: 'online', busy: true,
    labels: [{ name: 'self-hosted' }, { name: 'nibfin-user-2' }] };
  const workflow = { id: 50, path: expected.workflowPath, state: 'active' };
  const data = { '/actions/runs/20': run, '/actions/jobs/30': job, '/actions/runners/40': runner,
    '/actions/workflows/50': workflow, '/collaborators/member/permission': { user: member, permission: 'write' },
    '/collaborators/publisher/permission': { user: actor, permission: 'admin' },
    [`/contents/${expected.workflowPath}?ref=${expected.sourceCommit}`]: { type: 'file', path: expected.workflowPath,
      sha: expected.workflowBlob, encoding: 'base64', content: Buffer.from(body).toString('base64'), size: Buffer.byteLength(body) } };
  const reader = { repository: async () => structuredClone(repository), get: async path => {
    assert.ok(path.startsWith('/repos/example/core/')); const key = path.slice('/repos/example/core'.length);
    assert.ok(Object.hasOwn(data, key), `Unexpected request ${key}`); return structuredClone(data[key]);
  } };
  return { expected, repository, run, job, runner, workflow, data, reader };
}

test('native run, attempt, job, actual runner, member and installed workflow identities agree', async () => {
  const f = fixture(); const result = await readRunnerBinding(f.reader, f.expected);
  assert.equal(result.runnerId, 40); assert.equal(result.memberId, 2);
  assert.equal(Object.hasOwn(result, 'authorized'), false);
});

test('forged route, wrong Runner, wrong repo, fork/public input, stale attempt and changed source deny', async () => {
  const mutations = [
    f => { f.job.runner_id = 99; }, f => { f.runner.id = 99; }, f => { f.job.labels = ['self-hosted', 'nibfin-user-99']; },
    f => { f.run.event = 'pull_request'; }, f => { f.run.head_repository = { ...f.repository, id: 99 }; },
    f => { f.run.head_branch = 'candidate'; }, f => { f.run.head_sha = 'b'.repeat(40); },
    f => { f.run.run_attempt = 2; }, f => { f.job.run_attempt = 2; }, f => { f.job.run_id = 21; },
    f => { f.job.status = 'completed'; }, f => { f.run.status = 'cancelled'; },
    f => { f.run.triggering_actor = { id: 9, login: 'other', type: 'User' }; },
    f => { f.run.referenced_workflows = [{ sha: 'b'.repeat(40) }]; },
    f => { f.workflow.state = 'disabled_manually'; }, f => { f.runner.os = 'windows'; },
    f => { f.runner.status = 'offline'; }, f => { f.runner.busy = false; },
    f => { f.data['/collaborators/member/permission'].permission = 'read'; },
    f => { f.data['/collaborators/publisher/permission'].permission = 'read'; },
    f => { f.expected.member = { ...f.expected.member, id: 99 }; },
    f => { f.data[`/contents/${f.expected.workflowPath}?ref=${f.expected.sourceCommit}`].content = 'Zm9yZ2Vk'; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(readRunnerBinding(f.reader, f.expected)); }
});

test('provider failure and work ending during the read do not produce a live binding', async () => {
  const f = fixture(), get = f.reader.get; let jobs = 0;
  f.reader.get = async path => {
    const value = await get(path);
    if (path.endsWith('/actions/jobs/30') && ++jobs === 2) value.status = 'completed';
    return value;
  };
  await assert.rejects(readRunnerBinding(f.reader, f.expected), /CHANGED_DURING_READ/);
  f.reader.get = async () => { throw new Error('403'); };
  await assert.rejects(readRunnerBinding(f.reader, f.expected), /403/);
});
