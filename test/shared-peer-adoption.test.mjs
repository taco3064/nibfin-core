import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observePeer, peerConfiguration } from '../src/shared-peer-adoption.mjs';
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
