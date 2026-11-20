import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { managedIssueBinding, observePeer, peerConfiguration }
  from '../src/shared-peer-adoption.mjs';
import { observeExecutionPool } from '../src/shared-host-adopt.mjs';
import { callerRecipe, callerRecipeVariants } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';

import { fixture, name, root, head, source, actionCommit, memberId }
  from './peer-adoption-fixture.mjs';

test('peer adoption verifies callers on an unprotected target branch', async () => {
  const reader = fixture();
  const observed = await observePeer(reader, name, 123, memberId, source, actionCommit);
  const host = { memberId, uid: 500, stateRoot: '/state', tokenFile: '/private/token',
    sharedRunner: { runner: { runnerId: 2, runnerName: 'slot-1' } },
    repository: { isolation: { kind: 'linux-rootful-docker-v1' } } };
  const peer = peerConfiguration(host, name, 123, source, actionCommit, observed, head);
  assert.equal(peer.repository.runner.runnerId, 2);
  assert.equal(peer.repository.eventRunner.workflowId, 11);
  assert.equal(peer.repository.approval.repositoryId, 123);
  assert.equal(peer.tokenFile, undefined);
  reader.replies.get(root + '/collaborators/owner/permission').permission = 'write';
  await assert.rejects(observePeer(reader, name, 123, memberId, source, actionCommit),
    { code: 'PEER_INSTALLATION_ADMIN_REQUIRED' });
});

test('managed caller conversion keeps the same workflow identity', async () => {
  const reader = fixture();
  const observe = () => observePeer(reader, name, 123, memberId, source, actionCommit);
  const legacy = await observe();
  const event = { ...legacy.issue, sourceCommit: 'd'.repeat(40),
    reusable: { commit: source.commit }, runnerId: 56, memberId };
  const bytes = Buffer.from(callerRecipe('issue-managed', source.commit));
  const path = root + '/contents/' + event.workflowPath + '?ref=' + head;
  const file = reader.replies.get(path);
  file.sha = gitBlob(bytes);
  file.content = bytes.toString('base64');
  const managed = await observe();
  const updated = managedIssueBinding(event, managed, source.commit);
  assert.deepEqual(updated, { ...event, workflowBlob: file.sha, sourceCommit: head });
  assert.equal(managedIssueBinding(updated, managed, source.commit), updated);
  const native = managedIssueBinding(updated, legacy, source.commit);
  assert.deepEqual(native, { ...event, sourceCommit: head });
  assert.equal(managedIssueBinding(native, legacy, source.commit), native);
  for (const mismatch of [{ workflowId: 99 }, { workflowBlob: 'e'.repeat(40) }]) {
    const changed = { ...event, ...mismatch };
    assert.throws(() => managedIssueBinding(changed, managed, source.commit),
      { code: 'MANAGED_ISSUE_TRANSITION_CONFLICT' });
  }
});

test('managed adoption pins the workflow and both slots', async () => {
  const reader = fixture();
  const path = '.github/workflows/shared-runner.yml';
  const workflow = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  const bytes = Buffer.from(workflow);
  const branch = reader.replies.get(root + '/branches/main');
  branch.protected = true;
  reader.replies.get(root).owner = { id: 70 };
  const oidc = { use_default: true, use_immutable_subject: true };
  reader.replies.set(root + '/actions/oidc/customization/sub', oidc);
  reader.replies.set(root + '/actions/workflows/shared-runner.yml',
    { id: 55, path, state: 'active' });
  const callerFile = { type: 'file', path, encoding: 'base64', sha: gitBlob(bytes),
    content: bytes.toString('base64') };
  reader.replies.set(root + '/contents/' + path + '?ref=' + head, callerFile);
  const labels = [{ name: 'nibfin-shared' }, { name: 'nibfin-user-77' }];
  const slots = [1, 2].map(slot => ({ id: slot + 10, name: `nibfin-123-77-${slot}`,
    os: 'Linux', status: 'offline', busy: false, labels }));
  reader.list = async () => slots;
  let policy;
  const observe = () =>
    observeExecutionPool(reader, name, 123, memberId, [11, 12], source,
      actionCommit, workflow, policy);
  const pool = await observe();
  assert.equal(pool.runner.workflowId, 55);
  assert.equal(pool.caller.subject, 'repo:example@70/peer@123:ref:refs/heads/main');
  assert.equal(pool.second.runnerId, 12);
  oidc.use_immutable_subject = false;
  assert.equal((await observe()).caller.subject,
    'repo:example/peer:ref:refs/heads/main');
  delete oidc.use_immutable_subject;
  await assert.rejects(observe(), { code: 'SHARED_OIDC_SUBJECT_FORMAT_UNVERIFIED' });
  oidc.use_immutable_subject = true;
  oidc.use_default = false;
  await assert.rejects(observe(), { code: 'SHARED_CUSTOM_OIDC_TEMPLATE_UNSUPPORTED' });
  oidc.use_default = true;
  slots[1].busy = true;
  await assert.rejects(observe(), { code: 'SHARED_HOST_REGISTRATION_CHANGED' });
  slots[1].busy = false;
  branch.protected = false;
  await assert.rejects(observe(), { code: 'SHARED_EXECUTION_BRANCH_UNPROTECTED' });
  policy = { kind: 'repository-admission-v1', repository: name, repositoryId: 123,
    memberId, ownerId: 70 };
  assert.deepEqual((await observe()).runner.sharedAdmission, policy);
  policy.ownerId = 71;
  await assert.rejects(observe(), { code: 'SHARED_EXECUTION_OWNER_INVALID' });
});

test('peer observation accepts only exact historical and titled recipe variants',
  async () => {
    for (const issueKind of ['issue', 'issue-managed']) {
      for (const index of [0, 1]) {
        const reader = fixture();
        for (const [file, kind] of [['nibfin-issue.yml', issueKind],
          ['nibfin-wake.yml', 'action-dispatch']]) {
          const body = callerRecipeVariants(kind, source.commit,
            { actionCommit, memberId })[index].replaceAll('\n', '\r\n');
          const path = root + '/contents/.github/workflows/' + file + '?ref=' + head;
          const entry = reader.replies.get(path);
          entry.content = Buffer.from(body).toString('base64');
          entry.sha = gitBlob(body);
        }
        await observePeer(reader, name, 123, memberId, source, actionCommit);
        await assert.rejects(
          observePeer(reader, name, 123, memberId + 1, source, actionCommit),
          /PEER_INSTALLATION_IDENTITY_CHANGED/);
        const path = root + '/contents/.github/workflows/nibfin-issue.yml?ref=' + head;
        const entry = reader.replies.get(path);
        const body = Buffer.from(entry.content, 'base64').toString() + 'env: {}\n';
        entry.content = Buffer.from(body).toString('base64');
        entry.sha = gitBlob(body);
        await assert.rejects(
          observePeer(reader, name, 123, memberId, source, actionCommit),
          /CALLER_NOT_FIXED_RECIPE/);
      }
    }
  });
