import assert from 'node:assert/strict';
import { digest, gitBlob } from '../src/identity.mjs';
import { approvalRecord } from './approval-fixture.mjs';
export function runnerProviderFixture() {
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
  const job = { id: 30, check_run_url: 'https://api.github.com/repos/example/core/check-runs/40', run_id: 20, run_attempt: 1, status: 'in_progress', conclusion: null,
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

