import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWrites } from '../src/native-writes.mjs';
import { decideStage } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

function fixture(revokeAfterPush = false, credentialActor = 1) {
  const context = stageFixture('commit-pr'), committed = { head: '4'.repeat(40), base: context.candidate.base, tree: context.candidate.tree };
  delete context.pr;
  const calls = []; let revoked = false, pr;
  const reader = { repository: async () => ({ id: 10, full_name: 'example/core', private: false, default_branch: 'main' }),
    get: async path => {
      if (path.endsWith('/branches/main')) return { protected: true, commit: { sha: committed.base } };
      if (path.includes('/branches/nibfin')) return { commit: { sha: committed.head } };
      if (path.endsWith('/pulls/7')) return pr;
      throw new Error('Unexpected read');
    } };
  const assembly = nativeWrites({ reader, token: 'fixture-token', clock: () => now,
    observe: async () => { if (revoked) throw new Error('Permission revoked'); return structuredClone(context); },
    workspace: { push: async (head, branch, token, guard) => {
      assert.equal(token, 'fixture-token'); assert.equal(head, committed.head);
      await guard({ operation: 'commit-pr', targetHash: 'a'.repeat(64) });
      calls.push('push'); revoked = revokeAfterPush;
    } },
    fetcher: async (url, options) => {
      if (url === 'https://api.github.com/user') return { ok: true, json: async () => ({ type: 'User', id: credentialActor }) };
      calls.push('create-pr'); const body = JSON.parse(options.body);
      pr = { node_id: 'PR_7', number: 7, state: 'open', draft: false, title: body.title, body: body.body,
        head: { sha: committed.head, ref: body.head, repo: { id: 10 } }, base: { sha: committed.base, ref: 'main', repo: { id: 10 } } };
      return { ok: true, json: async () => pr };
    },
  });
  return { assembly, context, committed, calls, decision: decideStage('commit-pr', context, now) };
}

test('publication re-admits push and PR separately and verifies the actual created PR', async () => {
  const f = fixture();
  const result = await f.assembly.publishCommit(f.context, f.decision, f.committed);
  assert.equal(result.id, 'PR_7'); assert.equal(result.head, f.committed.head);
  assert.deepEqual(f.calls, ['push', 'create-pr']);
});

test('revocation after push blocks PR creation without undoing or repeating the ambiguous operation', async () => {
  const f = fixture(true);
  await assert.rejects(f.assembly.publishCommit(f.context, f.decision, f.committed));
  assert.deepEqual(f.calls, ['push']);
});

test('forged decision and swapped committed tree cannot reach publication', async () => {
  const f = fixture();
  assert.throws(() => f.assembly.writerFor('commit-pr', f.context, { ...f.decision, requestHash: '0'.repeat(64) }));
  await assert.rejects(f.assembly.publishCommit(f.context, f.decision, { ...f.committed, tree: '9'.repeat(40) }));
  assert.deepEqual(f.calls, []);
});


test('a different credential owner cannot impersonate the Runner member even with a valid stage decision', async () => {
  const f = fixture(false, 99);
  await assert.rejects(f.assembly.publishCommit(f.context, f.decision, f.committed), /WRITE_CREDENTIAL_IDENTITY_MISMATCH/);
  assert.deepEqual(f.calls, []);
});


test('rebased publication updates the existing PR with an exact old-head lease and rejects a moved branch', async () => {
  for (const moved of [false, true]) {
    const c = stageFixture('commit-pr'); c.pr = { ...c.pr, headBranch: 'nibfin/issue-2-444444444444' };
    const committed = { head: 'a'.repeat(40), base: c.candidate.base, tree: c.candidate.tree };
    let pushed = false, calls = 0;
    const pr = () => ({ node_id: c.pr.id, number: c.pr.number, state: 'open',
      head: { sha: pushed ? committed.head : moved ? 'b'.repeat(40) : c.pr.head, ref: c.pr.headBranch, repo: { id: 10 } },
      base: { sha: committed.base, repo: { id: 10 } } });
    const assembly = nativeWrites({ reader: { get: async () => pr() }, token: 'fixture-token', clock: () => now,
      observe: async () => structuredClone(c), fetcher: async url => {
        assert.equal(url, 'https://api.github.com/user'); return { ok: true, json: async () => ({ type: 'User', id: 1 }) };
      }, workspace: { push: async (head, branch, _token, guard, oldHead) => {
        assert.equal(head, committed.head); assert.equal(branch, c.pr.headBranch); assert.equal(oldHead, c.pr.head);
        await guard({ operation: 'commit-pr', targetHash: 'a'.repeat(64) }); pushed = true; calls++;
      } } });
    const result = assembly.publishCommit(c, decideStage('commit-pr', c, now), committed);
    if (moved) { await assert.rejects(result, /PR_REPAIR_HEAD_CHANGED/); assert.equal(calls, 0); }
    else { assert.equal((await result).id, c.pr.id); assert.equal(calls, 1); }
  }
});
