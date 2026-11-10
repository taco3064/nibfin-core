import assert from 'node:assert/strict';
import test from 'node:test';
import { readAdoptedOpenPr } from '../src/adopt-open-pr.mjs';

const issue = { id: 'I_15', number: 15, repositoryId: 10, repository: 'example/core' };
const pin = { issueId: issue.id, id: 'PR_125', number: 125, head: 'a'.repeat(40),
  tree: 'b'.repeat(40), parent: 'c'.repeat(40), candidateHash: 'd'.repeat(64) };
const branch = 'nibfin/issue-15-111111111111';

function fixture() {
  const pr = { node_id: pin.id, number: pin.number, user: { id: 12 },
    state: 'open', draft: false, merged: false,
    head: { sha: pin.head, ref: branch, repo: { id: issue.repositoryId } },
    base: { ref: 'main', repo: { id: issue.repositoryId } } };
  const commit = { sha: pin.head, tree: { sha: pin.tree }, parents: [{ sha: pin.parent }],
    message: `Deliver #15\n\nCandidate: ${pin.candidateHash}` };
  const ref = { object: { sha: pin.head } };
  const data = new Map([
    ['/repos/example/core/pulls/125', pr],
    [`/repos/example/core/git/commits/${pin.head}`, commit],
    [`/repos/example/core/git/ref/heads/${branch}`, ref],
  ]);
  return { pr, commit, ref, reader: { async get(path) { return data.get(path); } } };
}

test('adoption reads back the exact open PR and its Candidate commit', async () => {
  const { reader } = fixture();
  assert.deepEqual(await readAdoptedOpenPr(reader, issue, pin, 12),
    { id: pin.id, number: pin.number, repositoryId: issue.repositoryId,
      head: pin.head, headBranch: branch, state: 'open' });
});

test('adoption rejects changes in owner, repository, Candidate or ref', async () => {
  const mutations = [
    f => { f.pr.user.id = 13; },
    f => { f.pr.head.repo.id = 11; },
    f => { f.commit.tree.sha = 'e'.repeat(40); },
    f => { f.ref.object.sha = 'e'.repeat(40); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(readAdoptedOpenPr(f.reader, issue, pin, 12),
      { code: 'OPEN_PR_ADOPTION_CHANGED' });
  }
});
