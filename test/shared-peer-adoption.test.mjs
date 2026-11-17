import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { managedIssueBinding, observePeer, peerConfiguration }
  from '../src/shared-peer-adoption.mjs';
import { observeExecutionPool } from '../src/shared-host-adopt.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';

const name = 'example/peer';
const root = '/repos/' + name;
const head = 'a'.repeat(40);
const source = { repository: 'taco3064/nibfin-core', commit: 'b'.repeat(40) };
const actionCommit = 'c'.repeat(40);
const memberId = 77;

function fixture() {
  const branch = root + '/branches/main';
  const replies = new Map([
    [root, { id: 123, full_name: name, private: false, disabled: false,
      archived: false, default_branch: 'main' }],
    ['/user', { id: memberId, type: 'User', login: 'owner' }],
    [branch, { name: 'main', protected: false, commit: { sha: head } }],
    [root + '/collaborators/owner/permission', { permission: 'admin',
      user: { id: memberId } }],
  ]);
  for (const [file, kind, id] of [
    ['nibfin-issue.yml', 'issue', 11], ['nibfin-wake.yml', 'action-dispatch', 22],
  ]) {
    const path = '.github/workflows/' + file;
    const recipe = callerRecipe(kind, source.commit, { actionCommit, memberId });
    const bytes = Buffer.from(recipe);
    replies.set(root + '/actions/workflows/' + file, { id, path, state: 'active' });
    replies.set(root + '/contents/' + path + '?ref=' + head, {
      type: 'file', path, encoding: 'base64', sha: gitBlob(bytes),
      content: bytes.toString('base64'),
    });
  }
  return { replies, get: async path => {
    assert.ok(replies.has(path), path);
    return replies.get(path);
  } };
}

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
  assert.throws(() => managedIssueBinding(updated, legacy, source.commit),
    { code: 'MANAGED_ISSUE_TRANSITION_CONFLICT' });
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
