import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNativeNotificationRoutes }
  from '../src/native-notification-route.mjs';
import { observePeer, peerConfiguration } from '../src/shared-peer-adoption.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';
import { providerHost } from './provider-fixture.mjs';

async function fixture(kind = 'issue') {
  const host = providerHost();
  const commit = host.installation.pin.commit;
  const actionCommit = 'c'.repeat(40);
  const head = 'e'.repeat(40);
  const replies = new Map([['/user', { id: host.memberId, login: 'owner',
    type: 'User' }]]);
  const peers = new Map();
  const reader = { get: async path => {
    assert(replies.has(path), path);
    return structuredClone(replies.get(path));
  } };
  for (const id of host.sharedRunner.repositories) {
    const name = `example/repo${id}`, root = `/repos/${name}`;
    replies.set(root, { id, full_name: name, private: false, archived: false,
      disabled: false, default_branch: 'main' });
    replies.set(`${root}/branches/main`, { name: 'main', commit: { sha: head } });
    replies.set(`${root}/collaborators/owner/permission`, { permission: 'admin',
      user: { id: host.memberId } });
    for (const [file, recipe, workflowId] of [
      ['nibfin-issue.yml', kind, 10 + id],
      ['nibfin-wake.yml', 'action-dispatch', 20 + id],
    ]) {
      const path = `.github/workflows/${file}`;
      const bytes = Buffer.from(callerRecipe(recipe, commit,
        { actionCommit, memberId: host.memberId }));
      replies.set(`${root}/actions/workflows/${file}`,
        { id: workflowId, path, state: 'active' });
      replies.set(`${root}/contents/${path}?ref=${head}`, { type: 'file', path,
        encoding: 'base64', content: bytes.toString('base64'), sha: gitBlob(bytes) });
    }
    const observed = await observePeer(reader, name, id, host.memberId,
      { commit }, actionCommit);
    const peer = peerConfiguration(host, name, id, { commit }, actionCommit,
      observed, head);
    const path = `/etc/nibfin/host.peer-${id}.json`;
    peers.set(path, peer);
    if (id === 1) host.repository = peer.repository;
  }
  host.wakePeerFiles = ['/etc/nibfin/host.peer-2.json'];
  return { host, reader, peers, replies,
    run: () => observeNativeNotificationRoutes(host, reader,
      async path => structuredClone(peers.get(path))) };
}

test('actual native callers for every adopted consumer need no relay files', async () => {
  const f = await fixture();
  assert.deepEqual(await f.run(), [
    { repository: 'example/repo1', repositoryId: 1 },
    { repository: 'example/repo2', repositoryId: 2 },
  ]);
  // An ordinary unrelated repository commit is not a new local evidence gate.
  f.replies.get('/repos/example/repo1/branches/main').commit.sha = 'f'.repeat(40);
  for (const [path, value] of [...f.replies])
    if (path.startsWith('/repos/example/repo1/contents/'))
      f.replies.set(path.replace('e'.repeat(40), 'f'.repeat(40)), value);
  assert.equal((await f.run()).length, 2);
});

test('a live artifact consumer prevents shared notification cleanup', async () => {
  const f = await fixture('issue-managed');
  await assert.rejects(f.run(), { code: 'NOTIFICATION_ARTIFACT_CONSUMER_ACTIVE' });
});

test('a second consumer with changed adoption cannot be ignored', async () => {
  const f = await fixture();
  f.peers.get('/etc/nibfin/host.peer-2.json').repository.eventRunner.workflowId = 99;
  await assert.rejects(f.run(), { code: 'NOTIFICATION_ADOPTION_CHANGED' });
});

test('failed remote observation is not proof of native readiness', async () => {
  const f = await fixture();
  f.reader.get = async () => { throw Object.assign(new Error(), { code: 'EIO' }); };
  await assert.rejects(f.run(), { code: 'EIO' });
});

test('an identically identified archived consumer is legitimately retired', async () => {
  const f = await fixture('issue-managed');
  for (const id of [1, 2]) f.replies.get(`/repos/example/repo${id}`).archived = true;
  assert((await f.run()).every(consumer => consumer.retired === true));
  f.replies.get('/repos/example/repo1').id = 100;
  await assert.rejects(f.run(), { code: 'NOTIFICATION_CONSUMER_IDENTITY_CHANGED' });
});
