import test from 'node:test';
import assert from 'node:assert/strict';
import { gitBlob } from '../src/identity.mjs';
import { readRunnerBinding } from '../src/runner-binding.mjs';

import { runnerProviderFixture as fixture } from './runner-binding-fixture.mjs';

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


test('reusable workflow admission binds its public repository, immutable revision and exact source blob', async () => {
  const f = fixture(), body = '# Public reusable workflow fixture\n';
  const pinned = { repository: 'example/core', path: '.github/workflows/reusable.yml', commit: 'b'.repeat(40), blob: gitBlob(body) };
  pinned.ref = `${pinned.repository}/${pinned.path}@${pinned.commit}`;
  f.expected.reusable = pinned; f.run.referenced_workflows = [{ path: pinned.ref, sha: pinned.commit }];
  f.data[`/contents/${pinned.path}?ref=${pinned.commit}`] = { type: 'file', path: pinned.path, sha: pinned.blob,
    encoding: 'base64', content: Buffer.from(body).toString('base64'), size: Buffer.byteLength(body) };
  assert.equal((await readRunnerBinding(f.reader, f.expected)).checkRunId, 40);
  f.run.referenced_workflows[0].sha = 'c'.repeat(40);
  await assert.rejects(readRunnerBinding(f.reader, f.expected), /REUSABLE_WORKFLOW_SOURCE_CHANGED/);
  f.run.referenced_workflows[0].sha = pinned.commit;
  f.job.check_run_url = 'https://attacker.invalid/repos/example/core/check-runs/40';
  await assert.rejects(readRunnerBinding(f.reader, f.expected), /JOB_CHECK_IDENTITY_REQUIRED/);
});
