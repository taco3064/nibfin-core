import test from 'node:test';
import assert from 'node:assert/strict';
import { gitBlob } from '../src/identity.mjs';
import { upgradeContinuationContract as contract, upgradeRecipe }
  from '../src/upgrade-continuation-contract.mjs';
import { observeUpgradeProposal } from '../src/upgrade-continuation-proposals.mjs';
import { observeUpgradeExecutionRun, requireUpgradeInvocation }
  from '../src/upgrade-continuation-identity.mjs';

const consumer = { repository: 'member/project', repositoryId: 777 };
const execution = { repository: 'member/execution', repositoryId: 888, memberId: 999 };
const memberId = execution.memberId;
const head = 'a'.repeat(40), merged = 'b'.repeat(40);
const workflow = 32, owner = 808, pullNumber = 20;
const branch = { name: 'main', commit: { sha: head }, protected: true };
const repository = ({ repositoryId, repository: name }) =>
  ({ id: repositoryId, full_name: name, default_branch: 'main',
    owner: { id: owner }, private: false, archived: false, disabled: false });
const file = (kind, bytes = Buffer.from(upgradeRecipe(kind, memberId))) =>
  ({ type: 'file', path: contract.recipes[kind], encoding: 'base64',
    content: bytes.toString('base64'), sha: gitBlob(bytes) });
const pull = {
  id: 90, node_id: 'PR_TEST', number: pullNumber, user: { id: memberId, type: 'User' },
  head: { repo: { id: consumer.repositoryId }, ref: contract.proposalBranch, sha: head },
  base: { repo: { id: consumer.repositoryId }, ref: 'main' },
  state: 'closed', merged: true, merge_commit_sha: merged,
};
const compare = { status: 'ahead', merge_base_commit: { sha: merged } };
const run = {
  id: 101, run_attempt: 2, path: contract.recipes.execution, workflow_id: workflow,
  repository: { id: execution.repositoryId },
  head_repository: { id: execution.repositoryId },
  event: 'workflow_dispatch', head_branch: 'main', head_sha: head,
  status: 'in_progress', conclusion: null, pull_requests: [],
  actor: { id: memberId }, triggering_actor: { id: memberId },
};
const host = { sharedRunner: { caller: {
  ownerId: owner, ref: 'refs/heads/main',
  subject: 'repo:member/execution:ref:refs/heads/main',
} } };

function fixture(which, part = {}) {
  const root = `/repos/${which.repository}`;
  const kind = which === consumer ? 'notification' : 'execution';
  const calls = [];
  const recorded = {
    [root]: repository(which),
    [root + '/branches/main']: branch,
    [`${root}/pulls/${pullNumber}`]: pull,
    [`${root}/compare/${merged}...${head}`]: compare,
    [`${root}/contents/${contract.recipes[kind]}?ref=${head}`]: file(kind),
    [`${root}/actions/workflows/${contract.recipes[kind].split('/').at(-1)}`]:
      { path: contract.recipes[kind], id: workflow, state: 'active' },
    [`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}`]: run,
    ...part,
  };
  return { root, calls, reader: { async get(path) {
    calls.push(path);
    assert.ok(Object.hasOwn(recorded, path), path);
    const value = recorded[path];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  } } };
}

test('native proposal proof uses actual intent, merge ancestry and maintained source',
  async () => {
    const { reader, root, calls } = fixture(consumer);
    const observed = await observeUpgradeProposal(reader, consumer, pullNumber, memberId);
    assert.equal(observed.pullId, 90);
    assert.equal(observed.pullNodeId, 'PR_TEST');
    assert.equal(observed.merged, true);
    assert.equal(calls.filter(path => path === root + '/branches/main').length, 2);
    for (const [altered, code] of [
      [{ ...pull, merged: false }, 'UPGRADE_PROPOSAL_ABANDONED'],
      [{ ...pull, user: { id: 9001, type: 'User' } }, 'UPGRADE_PROPOSAL_NOT_AUTHORIZED'],
      [{ ...pull, head: { ...pull.head, repo: { id: 9001 } } },
        'UPGRADE_PROPOSAL_NOT_AUTHORIZED'],
    ]) {
      const changed = fixture(consumer, { [`${root}/pulls/${pullNumber}`]: altered });
      await assert.rejects(observeUpgradeProposal(changed.reader, consumer,
        pullNumber, memberId), { code });
    }
  });

test('unavailable remote reads never become proof of abandonment or a refused PR',
  async () => {
    const { root } = fixture(consumer);
    const unavailable = Object.assign(new Error('rate limit'), { status: 429 });
    const { reader } = fixture(consumer, {
      [`${root}/pulls/${pullNumber}`]: unavailable,
    });
    await assert.rejects(observeUpgradeProposal(reader, consumer, pullNumber, memberId),
      error => error === unavailable);
  });

test('native workflow rejects unrelated or modified upgrade source', async () => {
  const { reader, root } = fixture(execution);
  const request = { runId: run.id, attempt: run.run_attempt };
  const observed = await observeUpgradeExecutionRun(reader, execution, host, request);
  assert.equal(observed.workflowId, workflow);
  assert.equal(observed.actorId, memberId);
  assert.equal(observed.sourceCommit, head);
  const path = `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  for (const value of [{ ...run, event: 'pull_request' }, { ...run, run_attempt: 1 },
    { ...run, head_repository: { id: consumer.repositoryId } }]) {
    const outside = fixture(execution, { [path]: value });
    await assert.rejects(observeUpgradeExecutionRun(outside.reader, execution, host,
      request), { code: 'UPGRADE_EXECUTION_RUN_UNTRUSTED' });
  }
  const changed = fixture(execution, {
    [`${root}/contents/${contract.recipes.execution}?ref=${head}`]:
      file('execution', Buffer.from('name: Unapproved owned Job\n')),
  });
  await assert.rejects(
    observeUpgradeExecutionRun(changed.reader, execution, host, request),
    { code: 'UPGRADE_WORKFLOW_NOT_MAINTAINED' });
  assert.throws(() => requireUpgradeInvocation({}, {}), {
    code: 'UPGRADE_EXECUTION_NOT_ADMITTED',
  });
});
