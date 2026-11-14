import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitBlob } from '../src/identity.mjs';
import { admitSharedWorker, sharedWorkerContext }
  from '../src/security/shared-worker-admission.mjs';
import { readWorkerFrame } from '../src/security/shared-worker-frame.mjs';

const path = '.github/workflows/shared-runner.yml';
const commit = 'a'.repeat(40);
const ref = 'refs/heads/main';
const bytes = Buffer.from('pinned workflow\n');
const binding = {
  repository: 'example/project', repositoryId: 10, memberId: 20, workflowId: 30,
  sourceCommit: commit, workflowBlob: gitBlob(bytes), jobName: 'shared-stage',
};

function request(overrides = {}) {
  const values = {
    run_id: '40', run_attempt: '1', workflow_sha: commit, sha: commit,
    repository: binding.repository, repository_id: '10', actor_id: '20',
    event_name: 'workflow_dispatch', ref,
    workflow_ref: `${binding.repository}/${path}@${ref}`, ...overrides,
  };
  return {
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

test('reads the first message and preserves later bytes for cancellation', async () => {
  const body = Buffer.from(JSON.stringify(request()), 'utf16le');
  const header = Buffer.alloc(8);
  header.writeInt32LE(1, 0);
  header.writeInt32LE(body.length, 4);
  const cancellation = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]);
  const input = Buffer.concat([header, body, cancellation]);
  let offset = 0;
  const source = {
    read: async (buffer, start, size) => {
      const bytesRead = input.copy(buffer, start, offset, offset + Math.min(size, 3));
      offset += bytesRead;
      return { bytesRead };
    },
  };
  const parsed = await readWorkerFrame(source);
  assert.deepEqual(parsed.message, request());
  assert.deepEqual(input.subarray(offset), cancellation);
  await assert.rejects(readWorkerFrame(source), { code: 'SHARED_WORKER_FRAME_INVALID' });
});
