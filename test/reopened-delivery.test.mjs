import test from 'node:test';
import assert from 'node:assert/strict';
import { readReopenedDelivery } from '../src/reopened-delivery.mjs';
import { issueRequirementsChanged } from '../src/stages.mjs';

const issue = { repository: 'example/core', repositoryId: 10, number: 278,
  id: 'I_278' };
const merge = 'a'.repeat(40), head = 'b'.repeat(40);

function fixture(status = 'ahead') {
  const calls = [];
  const receipts = { close: { outcome: 'closed',
    artifacts: { prNumber: 282, prId: 'PR_282' } },
  merge: { outcome: 'merged', artifacts: { mergeCommit: merge } } };
  return { issue, receipts,
    live: { node_id: issue.id, number: issue.number, state: 'open' },
    observeMain: async () => ({ head }),
    reader: { get: async path => {
      calls.push(path);
      if (path.endsWith('/pulls/282')) return { number: 282, node_id: 'PR_282',
        base: { repo: { id: 10 } }, head: { repo: { id: 10 } },
        state: 'closed', merged: true, merge_commit_sha: merge };
      assert.equal(path, `/repos/example/core/compare/${merge}...${head}`);
      return { status, merge_base_commit: { sha: status === 'ahead'
        ? merge : 'c'.repeat(40) } };
    } }, calls };
}

test('same-body #278 reopen reuses native work still on current main', async () => {
  const f = fixture();
  assert.deepEqual(await readReopenedDelivery(f), { changed: false, close: true });
  assert.equal(f.calls.length, 2);
  delete f.receipts.close;
  f.receipts.merge.artifacts.prNumber = 282;
  assert.deepEqual(await readReopenedDelivery(f), { changed: false, close: false });
});

test('the #278 rolled-back main re-enters current requirements', async () => {
  assert.deepEqual(await readReopenedDelivery(fixture('diverged')),
    { changed: true, close: false });
});

test('a legitimate edit is considered even after a historical merge', async () => {
  const receipts = { shape: { requirementsBody: 'Original request' },
    merge: { outcome: 'merged' } };
  assert.equal(await issueRequirementsChanged({ state: 'open',
    body: 'Current request' }, receipts, () => {}), true);
  assert.equal(await issueRequirementsChanged({ state: 'closed',
    body: 'Current request' }, receipts, () => {}), false);
});

test('missing legacy merge metadata is recovered from its native PR', async () => {
  const f = fixture();
  delete f.receipts.merge.artifacts.mergeCommit;
  const result = await readReopenedDelivery(f);
  assert.equal(result.close, true);
  assert.equal(result.recoveredMerge.artifacts.mergeCommit, merge);
  delete f.receipts.merge;
  assert.deepEqual(await readReopenedDelivery(f),
    { changed: false, close: false, reconcile: true });
  delete f.receipts.close.artifacts.prNumber;
  assert.deepEqual(await readReopenedDelivery(f), { changed: true, close: false });
});

test('closed work and failed native observations cannot become fresh work', async () => {
  const f = fixture();
  f.live.state = 'closed';
  assert.deepEqual(await readReopenedDelivery(f), { changed: false, close: false });
  assert.equal(f.calls.length, 0);
  f.live.state = 'open';
  f.reader.get = async () => { throw Object.assign(new Error('Unavailable'),
    { githubApiRead: true, status: 503 }); };
  await assert.rejects(readReopenedDelivery(f), { status: 503 });
});
