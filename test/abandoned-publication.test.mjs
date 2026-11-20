import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWrites } from '../src/native-writes.mjs';
import { decideStage } from '../src/stages.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { nativeObserver } from '../src/native-observer.mjs';
import { digest } from '../src/identity.mjs';
import { publicationTargetAbandoned } from '../src/publication-target.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { now } from './approval-fixture.mjs';

function writerFixture(point) {
  const context = stageFixture('commit-pr');
  context.pr.headBranch = 'nibfin/issue-2-444444444444';
  const committed = { head: 'a'.repeat(40), base: context.candidate.base,
    tree: context.candidate.tree };
  let pushed = 0;
  const closed = { state: 'closed', merged: false, node_id: context.pr.id,
    number: context.pr.number, base: { repo: { id: context.pr.repositoryId } } };
  const open = { ...closed, state: 'open', head: { ref: context.pr.headBranch,
    sha: context.pr.head, repo: { id: context.pr.repositoryId } } };
  const assembly = nativeWrites({ clock: () => now, token: 'fixture-token',
    reader: { get: async () => point === 'before-push' || pushed ? closed : open },
    observe: async () => point === 'guard'
      ? { ...context, pr: undefined, abandonedPublication: context.pr.id }
      : context,
    fetcher: async () => ({ ok: true, json: async () => ({ type: 'User', id: 1 }) }),
    workspace: { async push(_head, _branch, _token, guard) {
      await guard({ operation: 'commit-pr', targetHash: 'b'.repeat(64) });
      pushed++;
    } },
  });
  const decision = decideStage('commit-pr', context, now);
  return { issue: context.approval.record.issue, decision,
    perform: () => assembly.publishCommit(context, decision, committed),
    pushed: () => pushed };
}

test('close before push never writes to the abandoned branch', async () => {
  for (const point of ['before-push', 'guard']) {
    const f = writerFixture(point);
    await assert.rejects(f.perform(), { code: publicationTargetAbandoned });
    assert.equal(f.pushed(), 0);
  }
});

test('close after push leaves uncertain effects pending', async () => {
  const f = writerFixture('read-back');
  await assert.rejects(f.perform(), { code: 'PR_REPAIR_READBACK_UNKNOWN' });
  assert.equal(f.pushed(), 1);
});

test('journal reopens only a proven pre-push abandonment', {
  skip: process.platform !== 'linux',
}, async t => {
  for (const point of ['before-push', 'read-back']) {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-publication-abandoned-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = writerFixture(point);
    const journal = new OperationJournal(root, f.issue);
    const outcome = await journal.run({ operation: 'commit-pr',
      bindingHash: f.decision.requestHash }, { admit: async () => f.decision.requestHash,
      perform: f.perform, readBack: async () => assert.fail('No result to verify') });
    if (point === 'before-push') {
      assert.equal(outcome.code, publicationTargetAbandoned);
      await journal.assertIdle();
    } else {
      assert.equal(outcome.code, 'EXTERNAL_EFFECT_UNKNOWN');
      await assert.rejects(journal.assertIdle(), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
    }
  }
});

test('direct publication reads current Candidate and never opens abandoned proofs',
  async t => {
    const f = await nativeFixture(t);
    const current = stageFixture('commit-pr');
    const receipts = structuredClone(current.receipts);
    receipts['commit-pr'].artifacts.candidateHash = 'e'.repeat(64);
    f.data['/pulls/1'] = { node_id: 'PR_1', number: 1,
      state: 'closed', merged: false, base: { repo: { id: 10 } } };
    const reads = [];
    const objects = new Map([[current.shape.hash, current.shape.body],
      [digest(current.candidate), current.candidate]]);
    const observe = nativeObserver({ ...f.adapters,
      stores: () => ({ load: async () => receipts, get: async key => {
        reads.push(key);
        assert.ok(objects.has(key), 'An abandoned proof must not be loaded');
        return objects.get(key);
      } }),
      localCommit: async () => assert.fail('An abandoned commit must not be loaded'),
    });
    const observed = await observe('commit-pr');
    assert.deepEqual([...new Set(reads)],
      [current.shape.hash, digest(current.candidate)]);
    assert.deepEqual(observed.candidate, current.candidate);
    assert.equal(observed.pr, undefined);
    assert.equal(observed.receipts['commit-pr'], undefined);
    assert.equal(observed.receipts['review-pr'], undefined);
    assert.equal(observed.receipts.merge, undefined);
  });
