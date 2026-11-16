import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gitBlob } from '../src/identity.mjs';
import { admitSharedWorker, sharedWorkerContext }
  from '../src/security/shared-worker-admission.mjs';
import { sharedWorkerDiagnostic, sharedWorkerReader }
  from '../src/security/shared-worker-reader.mjs';

const path = '.github/workflows/shared-runner.yml';
const commit = 'a'.repeat(40);
const ref = 'refs/heads/main';
const bytes = Buffer.from('pinned workflow\n');
const guid = '428ab2ad-025d-5d24-88c4-0ec8a5338679';
const binding = {
  repository: 'example/project', repositoryId: 10, memberId: 20, workflowId: 30,
  sourceCommit: commit, workflowBlob: gitBlob(bytes), jobName: 'shared-stage',
  runnerId: 50, runnerName: 'slot-1',
};

function request(overrides = {}) {
  const values = {
    run_id: '40', run_attempt: '1', workflow_sha: commit, sha: commit,
    repository: binding.repository, repository_id: '10', actor_id: '20',
    event_name: 'workflow_dispatch', ref,
    workflow_ref: `${binding.repository}/${path}@${ref}`, ...overrides,
  };
  return {
    jobId: guid,
    jobDisplayName: binding.jobName,
    contextData: {
      github: { t: 2, d: Object.entries(values).map(([k, v]) => ({ k, v })) },
    },
  };
}

function provider() {
  const repository = {
    id: 10, full_name: binding.repository, private: false, default_branch: 'main',
    archived: false, disabled: false, owner: { id: 20 },
  };
  const root = '/repos/example/project';
  const responses = {
    [root]: repository,
    [`${root}/actions/runs/40/attempts/1`]: {
      id: 40, run_attempt: 1, head_sha: commit, event: 'workflow_dispatch',
      workflow_id: 30, path, head_branch: 'main', repository,
      head_repository: repository, actor: { id: 20 }, triggering_actor: { id: 20 },
    },
    [`${root}/actions/workflows/30`]: { id: 30, path, state: 'active' },
    [`${root}/actions/runs/40/attempts/1/jobs?per_page=2`]: {
      total_count: 1, jobs: [{ id: 60, run_id: 40, run_attempt: 1, head_sha: commit,
        runner_id: 50, runner_name: 'slot-1', name: 'shared-stage',
        status: 'in_progress' }],
    },
    [`${root}/check-runs/60`]: {
      id: 60, name: 'shared-stage', head_sha: commit, external_id: guid,
      app: { slug: 'github-actions' },
      details_url: 'https://github.com/example/project/actions/runs/40/job/60',
    },
    [`${root}/branches/main`]: { protected: true, commit: { sha: commit } },
    [`${root}/contents/${path}?ref=${commit}`]: {
      path, type: 'file', size: bytes.length, encoding: 'base64',
      sha: gitBlob(bytes), content: bytes.toString('base64'),
    },
  };
  return { responses, get: async key => {
    assert.ok(responses[key], key);
    return responses[key];
  } };
}

test('authenticates every pre-Worker read, including Actions and Checks', async () => {
  const fixture = provider();
  const token = 'fake-job-token-for-this-test';
  const reads = new Set();
  const reader = sharedWorkerReader({ isSecret: true, value: token },
    async (url, options) => {
      const parsed = new URL(url);
      const key = parsed.pathname + parsed.search;
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.redirect, 'error');
      reads.add(key);
      return Response.json(await fixture.get(key));
    });
  await admitSharedWorker(reader, request(), binding, ref, 20);
  assert.deepEqual(reads, new Set(Object.keys(fixture.responses)));
});

test('denies missing credentials and reports only the failing path and HTTP status',
  async () => {
    const secret = 'fake-job-token-for-this-test';
    assert.throws(() => sharedWorkerReader({ isSecret: false, value: secret }),
      { code: 'SHARED_WORKER_READ_CREDENTIAL_UNAVAILABLE' });
    let calls = 0;
    const reader = sharedWorkerReader({ isSecret: true, value: secret }, async () => {
      calls++;
      return new Response(secret, { status: 403 });
    });
    const detail = 'SHARED_WORKER_PROVIDER_UNAVAILABLE GET ' +
      '/repos/example/project/actions/runs/40 HTTP 403';
    await assert.rejects(reader.get('/repos/example/project/actions/runs/40?a=1'),
      error => sharedWorkerDiagnostic(error) === detail);
    assert.equal(calls, 1);
  });

test('rejects a fork job or alternate Workflow before reading the provider', async () => {
  const reader = { get: () => assert.fail('unexpected GitHub read') };
  for (const overrides of [
    { event_name: 'pull_request' }, { repository_id: '999' },
    { ref: 'refs/heads/other' }, { workflow_sha: 'b'.repeat(40) },
    { workflow_ref: `example/project/.github/workflows/fork.yml@${ref}` },
  ]) {
    await assert.rejects(admitSharedWorker(reader, request(overrides), binding, ref, 20),
      { code: 'SHARED_WORKER_WORKFLOW_DENIED' });
  }
  const duplicate = request();
  duplicate.contextData.github.d.push({ k: 'actor_id', v: '20' });
  assert.throws(() => sharedWorkerContext(duplicate, binding, ref),
    { code: 'SHARED_WORKER_WORKFLOW_DENIED' });
});

test('requires the native slot assignment and Worker job identifier', async () => {
  const reader = provider();
  const path = '/repos/example/project/actions/runs/40/attempts/1/jobs?per_page=2';
  const job = reader.responses[path].jobs[0];
  job.runner_id = 51;
  await assert.rejects(admitSharedWorker(reader, request(), binding, ref, 20),
    { code: 'SHARED_WORKER_JOB_NOT_ASSIGNED' });
  job.runner_id = 50;
  await assert.rejects(admitSharedWorker(reader, {
    ...request(), jobId: '428ab2ad-025d-5d24-88c4-0ec8a5338678',
  }, binding, ref, 20), { code: 'SHARED_WORKER_JOB_IDENTITY_MISMATCH' });
});

test('requires GitHub run identity and protected, unrevoked Workflow bytes', async () => {
  const reader = provider();
  await admitSharedWorker(reader, request(), binding, ref, 20);
  const branch = reader.responses['/repos/example/project/branches/main'];
  branch.protected = false;
  await assert.rejects(admitSharedWorker(reader, request(), binding, ref, 20),
    { code: 'SHARED_WORKER_BRANCH_UNPROTECTED' });
  branch.protected = true;
  reader.responses['/repos/example/project/actions/workflows/30'].state =
    'disabled_manually';
  await assert.rejects(admitSharedWorker(reader, request(), binding, ref, 20),
    { code: 'SHARED_WORKER_PROVIDER_DENIED' });
});

test('the Linux dispatcher preserves Worker PID and refuses queued cancellation', {
  skip: process.platform !== 'linux',
}, () => {
  const path = '../src/security/shared-worker-dispatch.py';
  const dispatcher = new URL(path, import.meta.url);
  const probe = new URL('./shared-worker-process.py', import.meta.url);
  const result = spawnSync('/usr/bin/python3', [
    '-I', fileURLToPath(probe), fileURLToPath(dispatcher),
  ], { timeout: 15000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

// Exercise the same provider checks with branch protection deliberately absent.
test('managed admission drops only branch protection, retaining provider denial',
  async () => {
    const reader = provider();
    reader.responses['/repos/example/project/branches/main'].protected = false;
    const managed = { ...binding, sharedAdmission: {
      kind: 'repository-admission-v1', repository: binding.repository,
      repositoryId: 10, memberId: 20, ownerId: 20,
    } };
    await admitSharedWorker(reader, request(), managed, ref, 20);
    for (const [key, property, value] of [
      ['/actions/runs/40/attempts/1', 'triggering_actor', { id: 21 }],
      ['/actions/runs/40/attempts/1', 'run_attempt', 2],
      ['/actions/workflows/30', 'state', 'disabled_manually'],
      ['/check-runs/60', 'external_id', 'forged'],
    ]) {
      const record = reader.responses['/repos/example/project' + key];
      const original = record[property];
      record[property] = value;
      await assert.rejects(admitSharedWorker(reader, request(), managed, ref, 20));
      record[property] = original;
    }
    const file = reader.responses[
      '/repos/example/project/contents/' + path + '?ref=' + commit];
    file.content = Buffer.from('replaced').toString('base64');
    await assert.rejects(admitSharedWorker(reader, request(), managed, ref, 20),
      { code: 'PINNED_FILE_IDENTITY_MISMATCH' });
  });

test('managed pre-Worker checks run and current source lineage', async () => {
  const reader = provider();
  const managed = { ...binding, sharedAdmission: {
    kind: 'repository-admission-v1', repository: binding.repository,
    repositoryId: 10, memberId: 20, ownerId: 20,
  } };
  const root = '/repos/example/project';
  const current = 'c'.repeat(40);
  const branch = reader.responses[root + '/branches/main'];
  branch.protected = false;
  branch.commit.sha = current;
  reader.responses[`${root}/contents/${path}?ref=${current}`] =
    structuredClone(reader.responses[`${root}/contents/${path}?ref=${commit}`]);
  const comparison = { status: 'ahead', merge_base_commit: { sha: commit } };
  reader.responses[`${root}/compare/${commit}...${current}`] = comparison;
  const history = sha =>
    `${root}/commits?sha=${sha}&path=${encodeURIComponent(path)}&per_page=1`;
  reader.responses[history(commit)] = [{ sha: commit }];
  reader.responses[history(current)] = [{ sha: commit }];
  const admit = () => admitSharedWorker(reader, request(), managed, ref, 20);
  await admit();
  reader.responses[history(current)] = [{ sha: current }];
  await assert.rejects(admit(), { code: 'CALLER_REVOKED_OR_SUPERSEDED' });
  comparison.status = 'diverged';
  await assert.rejects(admit(), { code: 'CALLER_SOURCE_NOT_DESCENDANT' });
  comparison.status = 'ahead';
  reader.responses[history(current)] = [{ sha: commit }];
  // A descendant run is also verified, without changing the adoption anchor.
  const message = request({ workflow_sha: current, sha: current });
  reader.responses[root + '/actions/runs/40/attempts/1'].head_sha = current;
  reader.responses[root + '/actions/runs/40/attempts/1/jobs?per_page=2']
    .jobs[0].head_sha = current;
  reader.responses[root + '/check-runs/60'].head_sha = current;
  await admitSharedWorker(reader, message, managed, ref, 20);
  assert.equal(managed.sourceCommit, commit);
});
