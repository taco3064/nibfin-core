import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRolloutEnrollments } from '../src/rollout-enrollments.mjs';
import { observeRelayAttempt } from '../src/relay-observe.mjs';
import { relayFixture, origin, original, coreCommit, head } from './relay-fixture.mjs';
import { RelayReader } from '../src/relay-http.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';

function fixture(kind) {
  const commit = 'b'.repeat(40), actionCommit = 'c'.repeat(40);
  const repository = 'owner/project', actor = { id: 4, login: 'owner', type: 'User' };
  const paths = ['.github/workflows/nibfin-issue.yml',
    '.github/workflows/nibfin-wake.yml'];
  const sources = [callerRecipe(kind, coreCommit), callerRecipe('action-dispatch',
    coreCommit, { actionCommit, memberId: 4 })];
  const bindings = paths.map((workflowPath, index) => ({ workflowId: 20 + index,
    workflowPath, sourceCommit: commit, workflowBlob: gitBlob(sources[index]),
    ...(index ? { actionCommit } : {}) }));
  const target = { next: JSON.stringify({ repository: {
    approval: { repository, repositoryId: 1 },
    eventRunner: bindings[0], runner: bindings[1],
  } }) };
  let revoked = false;
  const reader = {
    repository: async () => ({ id: 1, full_name: repository, private: false,
      archived: false, disabled: false, default_branch: 'main' }),
    get: async path => {
      if (path === '/user') return actor;
      if (path.endsWith('/collaborators/owner/permission'))
        return { user: actor, permission: 'write' };
      if (path.endsWith('/branches/main')) return { commit: { sha: commit } };
      for (const [index, workflow] of bindings.entries()) {
        if (path.endsWith('/actions/workflows/' + workflow.workflowId))
          return { id: workflow.workflowId, path: workflow.workflowPath,
            state: revoked ? 'disabled_manually' : 'active' };
        if (path.includes('/contents/' + workflow.workflowPath)) return {
          type: 'file', path: workflow.workflowPath, encoding: 'base64',
          sha: workflow.workflowBlob, size: Buffer.byteLength(sources[index]),
          content: Buffer.from(sources[index]).toString('base64'),
        };
      }
      assert.fail(path);
    },
  };
  return { reader, target, revoke: () => { revoked = true; } };
}

for (const kind of ['issue', 'issue-managed']) {
  test(`enrollment readback preserves the ${kind} caller and authorized Action recipe`,
    async () => {
      const f = fixture(kind);
      await verifyRolloutEnrollments(f.reader, { memberId: 4 }, [f.target],
        { commit: coreCommit });
      f.revoke();
      await assert.rejects(verifyRolloutEnrollments(f.reader, { memberId: 4 }, [f.target],
        { commit: coreCommit }), { code: 'ROLLOUT_WORKFLOW_REVOKED' });
    });
}

test('shared targets verify their live Issue caller without retired wake adapters',
  async () => {
    const f = fixture('issue');
    const reader = { ...f.reader, get: async path => {
      if (path.endsWith('/actions/workflows/21'))
        return { id: 21, path: '.github/workflows/nibfin-wake.yml',
          state: 'disabled_manually' };
      return f.reader.get(path);
    } };
    const host = { memberId: 4, sharedRunner: { repositories: [1] } };
    await verifyRolloutEnrollments(reader, host, [f.target], { commit: coreCommit });
    await assert.rejects(verifyRolloutEnrollments(reader,
      { ...host, sharedRunner: { repositories: [2] } }, [f.target],
      { commit: coreCommit }), { code: 'ROLLOUT_WORKFLOW_REVOKED' });
    f.revoke();
    await assert.rejects(verifyRolloutEnrollments(reader, host, [f.target],
      { commit: coreCommit }), { code: 'ROLLOUT_WORKFLOW_REVOKED' });
  });

test('historical managed origins validate their original recipe and source ancestry',
  async t => {
    const f = await relayFixture(t);
    const next = 'c'.repeat(40);
    const base = new RelayReader('fake-controller-token', f.fetcher);
    let compared = false;
    const adoptedHead = 'd'.repeat(40);
    const advanced = { ...origin, workflow: { ...origin.workflow, commit: adoptedHead,
      blob: gitBlob(callerRecipe('issue-managed', next)) } };
    const reader = { get: async path => {
      if (path === `/repos/taco3064/nibfin-core/compare/${coreCommit}...${next}`) {
        compared = true;
        return { status: 'ahead', merge_base_commit: { sha: coreCommit } };
      }
      if (path === `/repos/${origin.repository}/compare/${head}...${adoptedHead}`)
        return { status: 'ahead', merge_base_commit: { sha: head } };
      return base.get(path);
    } };
    assert.equal((await observeRelayAttempt(reader, advanced, original.id, next,
      { historical: true })).id, original.id);
    assert.equal(compared, true);
    await assert.rejects(observeRelayAttempt(base, origin, original.id, next));
    const unrelated = { get: async path => path.includes('/compare/')
      ? { status: 'diverged' } : base.get(path) };
    await assert.rejects(observeRelayAttempt(unrelated, origin, original.id, next,
      { historical: true }), { code: 'RELAY_ORIGINAL_SOURCE_UNRELATED' });
  });
