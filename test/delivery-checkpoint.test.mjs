import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointMessage, matchesDeliveryCheckpoint, readDeliveryCheckpoint }
  from '../src/delivery-checkpoint.mjs';
import { digest } from '../src/identity.mjs';
import { idleIssueJobVms } from '../src/job-vm.mjs';
import { join } from 'node:path';
import { nativeWrites } from '../src/native-writes.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { decideStage } from '../src/stages.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { now } from './approval-fixture.mjs';
import { stageFixture } from './stage-fixture.mjs';

const head = 'a'.repeat(40);
const branch = 'nibfin/deliver-2';
const missing = { status: 404, githubApiRead: true };

test('checkpoint messages keep the final Candidate trailer', () => {
  const issue = { id: 'I_target', number: 2 };
  const candidate = { tree: head, base: 'b'.repeat(40) };
  for (const mode of ['completed', 'progress']) {
    const message = checkpointMessage(issue, { shape: 'Requirements',
      lifecycle: 0, mode }, candidate);
    assert.ok(message.includes(`\nStatus: ${mode}\n`));
    assert.ok(message.trim().endsWith(`Candidate: ${digest(candidate)}`));
  }
});

function fixture(outcome = 'ready') {
  const context = stageFixture('deliver');
  const candidate = context.candidate;
  delete context.candidate;
  const calls = [];
  const writerInputs = [];
  let commit, staged, closed = false, loseResponse = false, status, publication;
  let unavailableReadBack = false;
  const reader = {
    repository: async () => ({ id: candidate.repositoryId, default_branch: 'main' }),
    async get(path) {
      if (path.endsWith('/branches/nibfin%2Fdeliver-2')) {
        if (unavailableReadBack && calls.at(-1) === 'push') {
          unavailableReadBack = false;
          throw { status: 503, githubApiRead: true };
        }
        if (status) throw { ...missing, status };
        if (commit) return { name: branch, commit };
        throw missing;
      }
      assert.ok(path.endsWith(`/git/commits/${commit.sha}`));
      return commit;
    },
    async list(path) {
      assert.ok(path.endsWith('/pulls?state=all&head=' + encodeURIComponent(
        `example:nibfin/issue-2-${commit.sha.slice(0, 12)}`)));
      const repo = { id: candidate.repositoryId };
      return closed && commit.sha === head ? [{ state: 'closed', merged_at: null,
        head: { sha: head, ref: `nibfin/issue-2-${head.slice(0, 12)}`, repo },
        base: { ref: 'main', repo } }] :
        publication ? [publication] : [];
    },
  };
  const install = (binding = { shape: context.shape.body, lifecycle: 0 }, sha = head) => {
    commit = { sha, tree: { sha: candidate.tree },
      parents: [{ sha: candidate.base }],
      message: checkpointMessage(context.approval.record.issue, binding, candidate) };
  };
  const workspace = {
    capture: async () => candidate,
    discardWriterGit: async () => { calls.push('cleanup'); },
    restoreDeliveryCheckpoint: async saved => {
      calls.push('restore');
      assert.equal(matchesDeliveryCheckpoint(saved, candidate, saved.mode), true);
      return candidate;
    },
    async commit(value, _shape, _timestamp, partial, binding) {
      assert.deepEqual(value, candidate);
      assert.equal(partial, binding.mode === 'progress');
      calls.push('commit');
      staged = { head: commit ? 'b'.repeat(40) : head, binding };
      return staged;
    },
    async push(commitHead, target, credential, guard, expected, operation) {
      assert.deepEqual([commitHead, target, credential, expected],
        [staged.head, branch, 'fixture-token', commit?.sha ?? null]);
      await guard({ operation, targetHash: 'b'.repeat(64) });
      calls.push('push');
      install(staged.binding, staged.head);
      if (loseResponse) throw new Error('transport response absent');
    },
  };
  const native = nativeWrites({ reader, token: 'fixture-token', workspace,
    observe: async () => context, clock: () => now,
    fetcher: async url => {
      assert.equal(url, 'https://api.github.com/user');
      return { ok: true, json: async () => ({ id: context.execution.actorId,
        type: 'User' }) };
    } });
  const agent = { run: async (_stage, input) => {
    writerInputs.push(input);
    calls.push('writer');
    const lastMessage = JSON.stringify({ outcome, body: '',
      summary: 'Controlled delivery', rootCause: '', failureClass: 'none',
      evidenceReferences: ['fixture:writer'], blockingFindings: [],
      contractConflicts: [] });
    const events = [{ type: 'thread.started', thread_id: context.execution.sessionId },
      { type: 'turn.started' }, { type: 'item.completed',
        item: { type: 'agent_message', text: lastMessage } }, { type: 'turn.completed' }];
    return { executionId: context.execution.id, terminationHash: digest('termination'),
      lastMessage, stdout: events.map(JSON.stringify).join('\n') };
  } };
  const callbacks = stageHandlers({ agent, workspace, ...native,
    store: { put: async value => digest(value) }, observeMain: async () => context.main,
    clock: () => now,
  }).deliver;
  return { context, candidate, calls, writerInputs, reader, native, install,
    loseResponse: () => { loseResponse = true; },
    loseReadBack: () => { unavailableReadBack = true; },
    knownPublication: value => { publication = value; },
    replaceMessage: message => { commit.message = message; },
    closePr: () => { closed = true; }, failRead: code => { status = code; },
    start: async () => {
      const decision = decideStage('deliver', context, now);
      assert.equal(decision.status, 'allowed');
      return callbacks.readBack(context, await callbacks.perform(context, decision),
        decision);
    } };
}

test('Deliver captures and saves once before returning Ready', async () => {
  const f = fixture();
  f.loseResponse();
  const result = await f.start();
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.deliveryCheckpoint, { branch, head });
  assert.deepEqual(f.calls, ['writer', 'cleanup', 'commit', 'push']);
});

test('confirmed handoff resumes without a Writer or another push', async () => {
  const f = fixture();
  f.install();
  assert.equal((await f.start()).artifacts.candidateHash, digest(f.candidate));
  assert.deepEqual(f.calls, ['restore']);
});

test('reopened or abandoned checkpoint returns to normal Deliver', async () => {
  for (const abandon of ['pr', 'reopened']) {
    const f = fixture();
    f.install();
    if (abandon === 'pr') f.closePr();
    else f.context.pause.events = [{ event: 'reopened', id: 42 }];
    assert.equal((await f.start()).outcome, 'ready');
    assert.equal(f.calls[0], 'writer');
    assert.equal(f.calls.includes('restore'), false);
  }
});

test('an unavailable GitHub ref is distinct from a ref that is absent', async () => {
  const f = fixture();
  f.failRead(503);
  await assert.rejects(f.start(), { status: 503, githubApiRead: true });
  assert.deepEqual(f.calls, []);
  f.failRead(404);
  const saved = await readDeliveryCheckpoint(f.reader, f.context.approval.record.issue,
    { shape: f.context.shape.body, lifecycle: 0 });
  assert.deepEqual(saved, { branch, head: null });
});

test('the work branch is never overwritten when its ownership is unproven', async () => {
  const f = fixture();
  f.install();
  f.replaceMessage('Maintainer-owned branch');
  await assert.rejects(f.start(), { code: 'DELIVER_BRANCH_OWNERSHIP_UNPROVEN' });
  assert.deepEqual(f.calls, ['writer', 'cleanup']);
});

test('publication reuses the exact open PR after controller loss', async () => {
  const f = fixture();
  f.install();
  const context = stageFixture('commit-pr');
  delete context.pr;
  context.receipts.deliver.deliveryCheckpoint = { branch, head };
  const repo = { id: f.candidate.repositoryId };
  f.knownPublication({ node_id: 'PR_RETAINED', number: 9, user: { id: 1 },
    head: { sha: head, ref: `nibfin/issue-2-${head.slice(0, 12)}`, repo },
    base: { ref: 'main', repo }, state: 'open', draft: false, title: 'Deliver #2',
    body: `Implements #2.\n\nCandidate: ${digest(f.candidate)}` });
  const saved = await f.native.reuseDeliverCommit(context);
  const result = await f.native.publishCommit(context,
    decideStage('commit-pr', context, now), saved);
  assert.equal(result.id, 'PR_RETAINED');
  assert.equal(result.head, head);
  assert.deepEqual(f.calls, []);
});

test('a confirmed merged PR on a fresh host prevents a second delivery', async () => {
  const f = fixture();
  f.install();
  const repo = { id: f.candidate.repositoryId };
  const merge = 'e'.repeat(40);
  f.knownPublication({ node_id: 'PR_MERGED', number: 9,
    head: { sha: head, ref: `nibfin/issue-2-${head.slice(0, 12)}`, repo },
    base: { ref: 'main', repo }, state: 'closed', draft: false,
    merged_at: '2026-11-21T01:20:00.000Z', merge_commit_sha: merge });
  const result = await f.start();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.report.code, 'MERGED_DELIVERY_CLOSURE_EVIDENCE_MISSING');
  assert.deepEqual(result.references, ['https://github.com/example/core/pull/9']);
  assert.match(result.findings[0], new RegExp(merge));
  assert.deepEqual(f.calls, []);
});

test('new continuation persists an old local Ready before starting Accept', async () => {
  const c = stageFixture('accept');
  const stages = [];
  const receipts = structuredClone(c.receipts);
  for (const stage of ['accept', 'post-accept-hooks', 'commit-pr', 'review-pr', 'merge'])
    delete receipts[stage];
  const candidateHash = receipts.deliver.artifacts.candidateHash;
  const objects = new Map([[candidateHash, c.candidate]]);
  const result = await continueStages({ saveDeliverCheckpoint: true,
    store: { load: async () => structuredClone(receipts),
      get: async key => objects.get(key) }, inspect: async () => {},
    execute: async stage => {
      stages.push(stage);
      if (stage === 'accept') return { stage, status: 'denied' };
      if (stage === 'deliver') receipts.deliver.deliveryCheckpoint = { branch, head };
      const receiptHash = digest(receipts[stage]);
      objects.set(receiptHash, receipts[stage]);
      return { stage, status: 'completed', receiptHash };
    } });
  assert.deepEqual(stages, ['deliver', 'pre-accept-hooks', 'accept']);
  assert.equal(result.stage, 'accept');
});

test('only live VM processes for the target Issue block handback', async () => {
  const issue = join('fixture', 'issue-10-2');
  const guest = { state: 'S', command: ['firecracker', '--config-file',
    join(issue, 'job-vm-demo', 'vm.json')] };
  const unrelated = { state: 'S', command: ['firecracker', '--config-file',
    join('fixture', 'issue-10-3', 'job-vm-demo', 'vm.json')] };
  await idleIssueJobVms(issue, async () => [unrelated, { ...guest, state: 'Z' }]);
  await assert.rejects(idleIssueJobVms(issue, async () => [guest]),
    { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
});


test('progress saves after termination and cannot be reused as completed', async () => {
  const f = fixture('progress');
  f.loseResponse();
  assert.equal((await f.start()).outcome, 'progress');
  const saved = await f.native.observeDeliver(f.context);
  assert.equal(saved.mode, 'progress');
  assert.equal(matchesDeliveryCheckpoint(saved, f.candidate), false);
  assert.equal(matchesDeliveryCheckpoint(saved, f.candidate, 'progress'), true);
  assert.deepEqual(f.calls, ['writer', 'cleanup', 'commit', 'push']);
});

test('progress on a fresh Runner resumes Writer and completes even the same tree',
  async () => {
    const f = fixture();
    f.install({ shape: f.context.shape.body, lifecycle: 0, mode: 'progress' });
    f.loseResponse();
    assert.equal((await f.start()).outcome, 'ready');
    assert.deepEqual(f.calls, ['restore', 'writer', 'cleanup', 'commit', 'push']);
    assert.equal((await f.native.observeDeliver(f.context)).mode, 'completed');
    assert.equal(f.writerInputs[0].deliveryProgress.saved, true);
  });

test('legacy unmarked completed checkpoints keep their handoff reuse', async () => {
  const f = fixture();
  f.install();
  const message = checkpointMessage(f.context.approval.record.issue,
    { shape: f.context.shape.body, lifecycle: 0 }, f.candidate);
  f.replaceMessage(message.replace('Status: completed\n', ''));
  assert.equal((await f.start()).outcome, 'ready');
  assert.deepEqual(f.calls, ['restore']);
});

test('progress is ineligible after requirements or lifecycle changes', async () => {
  for (const binding of [
    { shape: 'Different requirements', lifecycle: 0, mode: 'progress' },
    { shape: fixture().context.shape.body, lifecycle: 1, mode: 'progress' },
  ]) {
    const f = fixture();
    f.install(binding);
    assert.equal((await f.start()).outcome, 'ready');
    assert.deepEqual(f.calls, ['writer', 'cleanup', 'commit', 'push']);
  }
});


test('progress never publishes empty or protected changes', async () => {
  const empty = fixture('progress');
  empty.candidate.paths = [];
  await assert.rejects(empty.start(), { code: 'EMPTY_DELIVER_PROGRESS' });
  assert.deepEqual(empty.calls, ['writer', 'cleanup']);
  const protectedWork = fixture('progress');
  protectedWork.candidate.paths.push('.github/workflows/ci.yml');
  assert.equal((await protectedWork.start()).outcome, 'changes_required');
  assert.deepEqual(protectedWork.calls, ['writer', 'cleanup']);
});


test('progress reconciles a confirmed remote effect after failed readback', async () => {
  const f = fixture('progress');
  f.loseResponse();
  f.loseReadBack();
  await assert.rejects(f.start(), { status: 503, githubApiRead: true });
  const checkpoint = await f.native.observeDeliver(f.context);
  const confirmed = await f.native.saveDeliver(f.context,
    decideStage('deliver', f.context, now), f.candidate, checkpoint, 'progress');
  assert.equal(confirmed.mode, 'progress');
  assert.deepEqual(f.calls, ['writer', 'cleanup', 'commit', 'push']);
});
