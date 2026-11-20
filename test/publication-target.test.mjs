import assert from 'node:assert/strict';
import test from 'node:test';
import { observePublication } from '../src/publication-target.mjs';
import { continueStages } from '../src/stage-continuation.mjs';

const issue = { id: 'I_563', number: 563, repository: 'example/core', repositoryId: 1 };
const old = { prId: 'PR_570', prNumber: 570, candidateHash: 'discarded' };
const closed = { node_id: old.prId, number: old.prNumber, state: 'closed',
  merged: false, base: { repo: { id: issue.repositoryId } }, head: { repo: null } };

function fixture(candidateHash = 'current') {
  const outcomes = { shape: 'ready', 'validate-shape': 'approved',
    'publish-shape': 'published', deliver: 'ready', 'pre-accept-hooks': 'passed',
    accept: 'accepted', 'post-accept-hooks': 'passed' };
  const receipts = Object.fromEntries(Object.entries(outcomes).map(([stage, outcome]) =>
    [stage, { stage, outcome, artifacts: ['shape', 'validate-shape', 'publish-shape']
      .includes(stage) ? { shapeHash: 'current-shape' }
      : { shapeHash: 'current-shape', candidateHash } }]));
  receipts['commit-pr'] = { stage: 'commit-pr', outcome: 'published', artifacts: old };
  receipts['review-pr'] = { stage: 'review-pr', outcome: 'approved', artifacts: old };
  const reads = [];
  const reader = { get: async path => { reads.push(path); return closed; } };
  return { receipts, reader, reads };
}

test('continuation resumes publication for #563 without old Candidate or PR proof',
  async () => {
    const { receipts, reader, reads } = fixture();
    let next;
    const result = await continueStages({
      store: { get: async key => {
        assert.equal(key, 'current');
        return { paths: [] };
      } },
      readReceipts: async () =>
        (await observePublication(reader, issue, receipts)).receipts,
      inspect: async () => {},
      wait: async () => {},
      execute: async stage => {
        next = stage;
        return { status: 'pending', stage };
      },
    });
    assert.equal(next, 'commit-pr');
    assert.equal(result.stage, 'commit-pr');
    assert.deepEqual(reads, ['/repos/example/core/pulls/570']);
    assert.equal(receipts['commit-pr'].artifacts.prNumber, 570);
  });

test('an abandoned PR releases only its own Candidate and handoff', async () => {
  const { receipts, reader, reads } = fixture('discarded');
  const handoff = { issueId: issue.id, number: 570, id: 'PR_570' };
  const active = await observePublication(reader, issue, receipts, handoff);
  assert.equal(active.restartCandidate, true);
  assert.equal(active.handoff, null);
  assert.deepEqual(Object.keys(active.receipts), [
    'shape', 'validate-shape', 'publish-shape',
  ]);
  assert.deepEqual(reads, ['/repos/example/core/pulls/570']);
});

test('open and merged PRs remain selected, and failed reads propagate', async () => {
  const { receipts } = fixture();
  for (const [state, merged] of [['open', false], ['closed', true]]) {
    const pr = { ...closed, state, merged };
    const current = await observePublication({ get: async () => pr }, issue, receipts);
    assert.equal(current.pr, pr);
    assert.equal(current.receipts, receipts);
  }
  const failure = new Error('Temporary GitHub failure');
  await assert.rejects(observePublication({ get: async () => { throw failure; } },
    issue, receipts), failure);
});

test('an interrupted adopted workspace needs refresh even without a saved Candidate',
  async () => {
    const { receipts, reader } = fixture();
    for (const key of ['commit-pr', 'review-pr', 'deliver']) delete receipts[key];
    const handoff = { issueId: issue.id, number: 570, id: 'PR_570',
      candidateHash: old.candidateHash };
    const rejected = await observePublication(reader, issue, receipts, handoff);
    assert.equal(rejected.restartCandidate, true);
    assert.equal(rejected.handoff, null);
    receipts.deliver = { outcome: 'ready', artifacts: { candidateHash: 'independent' } };
    const independent = await observePublication(reader, issue, receipts, handoff);
    assert.equal(independent.restartCandidate, false);
    assert.equal(independent.receipts.deliver, receipts.deliver);
  });

test('closure without a matching identity and explicit merge state cannot retire a PR',
  async () => {
    const { receipts } = fixture();
    const { merged: _mergeState, ...unknown } = closed;
    const responses = [unknown, { ...closed, merged: null },
      { ...closed, node_id: 'PR_other' }, { ...closed, number: 571 },
      { ...closed, base: { repo: { id: 2 } } }];
    for (const response of responses) {
      await assert.rejects(observePublication({ get: async () => response },
        issue, receipts), { code: 'PR_RECEIPT_IDENTITY_CHANGED' });
    }
  });

test('conflicting completion for a different PR stops replacement publication',
  async () => {
    for (const [stage, outcome] of [['merge', 'merged'], ['close', 'closed']]) {
      const { receipts, reader } = fixture();
      receipts[stage] = { stage, outcome,
        artifacts: { prId: 'PR_605', prNumber: 605 } };
      await assert.rejects(observePublication(reader, issue, receipts),
        { code: 'PUBLICATION_RECEIPTS_CONFLICT' });
    }
  });
