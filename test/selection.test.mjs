import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAssignee } from '../src/selection.mjs';

const user = id => ({ id, login: `member-${id}`, type: 'User' });

test('selects first eligible member in provider order without sorting', async () => {
  const seen = [];
  const selected = await selectAssignee({ assignees: [user(9), user(2), user(1)] }, async u => {
    seen.push(u.id); return u.id !== 9;
  });
  assert.deepEqual(seen, [9, 2]);
  assert.deepEqual(selected, { userId: 2, login: 'member-2', label: 'nibfin-user-2' });
});

test('offline or busy metadata never causes cross-member fallback', async () => {
  for (const status of ['offline', 'busy']) {
    const first = { ...user(9), runnerStatus: status };
    assert.equal((await selectAssignee({ assignees: [first, user(2)] }, async () => true)).userId, 9);
  }
});

test('unknown or failed authorization stops rather than skipping a member', async () => {
  for (const result of [undefined, null, 'yes', 1]) {
    await assert.rejects(selectAssignee({ assignees: [user(1), user(2)] }, async () => result));
  }
  await assert.rejects(selectAssignee({ assignees: [user(1), user(2)] }, async () => { throw new Error('403'); }));
});

test('empty and ineligible assignee lists return no route', async () => {
  assert.equal(await selectAssignee({ assignees: [] }, async () => true), null);
  assert.equal(await selectAssignee({ assignees: [user(1)] }, async () => false), null);
});

test('malformed or duplicate identities deny before any eligibility lookup', async () => {
  for (const assignees of [[user(1), user(1)], [user(0)], [{ ...user(1), type: 'Bot' }], [{ ...user(1), id: '1' }]]) {
    let called = false;
    await assert.rejects(selectAssignee({ assignees }, async () => { called = true; return true; }));
    assert.equal(called, false);
  }
});
