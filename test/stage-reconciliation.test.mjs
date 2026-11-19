import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayControllerRequest } from '../src/host-relay.mjs';
import { reconcileDelivery } from '../src/stage-reconciliation.mjs';
import { hostExecution } from '../src/host-launcher.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { settleHostStage } from '../src/host-stage-settlement.mjs';
import { releaseControllerResult } from '../src/controller-result.mjs';
import { acquireHostFence, issueStatePath } from '../src/host-fence.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest } from '../src/identity.mjs';
import {
  reconciliationFixture, premergeFixture,
} from './reconciliation-fixture.mjs';

const observe = f => reconcileDelivery(f.input, f.dependencies);

test('repeated settled observations return the same terminal receipt', async () => {
  const f = reconciliationFixture();
  const first = await observe(f);
  assert.deepEqual(first, { schemaVersion: 1, status: 'completed', stage: 'continue',
    terminalStage: 'close', receiptHash: digest(f.receipts.close) });
  assert.deepEqual(await observe(f), first);
  assert.equal(f.counts.acquired, 2);
  assert.equal(f.counts.released, 2);
  assert.equal(f.counts.settled, 4);
});

test('merged PR base advancement preserves the recorded delivery proof', async () => {
  for (const base of ['4'.repeat(40), 'f'.repeat(40)]) {
    const f = reconciliationFixture();
    f.pr.base.sha = base;
    const result = await observe(f);
    assert.equal(result.status, 'completed');
    assert.equal(result.receiptHash, digest(f.receipts.close));
    assert.deepEqual(await observe(f), result);
    assert.equal(f.counts.released, 2);
  }
});

test('a rewritten merge verifies its original base and integration tree', async () => {
  const f = reconciliationFixture();
  f.pr.base.sha = 'f'.repeat(40);
  f.merge.parents = [{ sha: f.candidate.base }];
  assert.equal((await observe(f)).status, 'completed');
  f.merge.parents[0].sha = 'e'.repeat(40);
  assert.equal((await observe(f)).status, 'pending');
});

test('a live or retained real fence is never reclaimed', async t => {
  const f = reconciliationFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  f.input.context.host.stateRoot = root;
  const issue = f.input.approval.record.issue;
  const state = issueStatePath(root, issue);
  await mkdir(state, { mode: 0o700 });
  const fence = await acquireHostFence(state, { original: true });
  delete f.dependencies.acquire;
  for (let observation = 0; observation < 2; observation++) {
    assert.equal((await observe(f)).status, 'pending');
    await fence.inspect();
  }
  assert.equal(f.reads.length, 0);
  await fence.release();
});

test('unknown effects and containers retain the reconciliation fence', async () => {
  for (const fault of ['EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED',
    'PREVIOUS_HOST_PROCESS_UNRESOLVED', 'JOURNAL_CORRUPT']) {
    const f = reconciliationFixture();
    const fail = async () => { throw Object.assign(new Error(fault), { code: fault }); };
    if (fault === 'PREVIOUS_HOST_PROCESS_UNRESOLVED') f.dependencies.containers = fail;
    else f.dependencies.journal.assertIdle = fail;
    assert.equal((await observe(f)).status, 'pending');
    assert.equal(f.counts.released, 0);
    assert.equal(f.reads.length, 0);
  }
});

test('native request and execution mismatches stay Pending', async () => {
  for (const field of ['repositoryId', 'runId', 'attempt', 'jobId', 'memberId',
    'sourceCommit']) {
    const f = reconciliationFixture();
    f.input.runner[field] = field === 'sourceCommit' ? 'f'.repeat(40) : 999;
    f.input.closeExecution = hostExecution(f.input.runner, 'close');
    assert.equal((await observe(f)).status, 'pending', field);
  }
  for (const field of ['id', 'sessionId', 'actorId', 'role',
    'runId', 'attempt', 'jobId']) {
    const f = reconciliationFixture();
    f.receipts.close.execution[field] = field.includes('Id') ? 999 : 'unrelated';
    assert.equal((await observe(f)).status, 'pending', field);
  }
});

test('missing, corrupt, stale and contradictory evidence stays Pending', async () => {
  const mutations = [
    f => { delete f.receipts.close; },
    f => { delete f.receipts.accept; },
    f => { f.receipts.close.outcome = 'blocked'; },
    f => { f.receipts.close.binding = { ...f.binding, issueId: 'I_other' }; },
    f => { f.receipts.close.binding = { ...f.binding, approvalHash: 'f'.repeat(64) }; },
    f => { f.objects.delete(f.receipts.close.artifacts.candidateHash); },
    f => { f.objects.set(f.receipts.close.artifacts.candidateHash, { corrupt: true }); },
    f => { f.receipts.merge.artifacts.head = 'f'.repeat(40); },
    f => { f.receipts['commit-pr'].artifacts.prId = 'PR_other'; },
    f => { f.receipts['commit-pr'].artifacts.base = 'f'.repeat(40); },
    f => { f.receipts.deliver.artifacts.candidateHash = f.put({
      ...f.candidate, repositoryId: 999 }); },
    f => { f.live.node_id = 'I_other'; },
    f => { f.live.number++; },
    f => { f.live.state = 'open'; },
    f => { f.live.labels = []; },
    f => { f.pr.merged = false; },
    f => { f.pr.node_id = 'PR_other'; },
    f => { f.pr.head.repo.id = 999; },
    f => { f.pr.head.sha = 'f'.repeat(40); },
    f => { f.pr.base.repo.id = 999; },
    f => { f.merge.parents[0].sha = 'f'.repeat(40); },
    f => { f.merge.parents[1].sha = 'f'.repeat(40); },
    f => { f.merge.tree.sha = 'f'.repeat(40); },
    f => { f.preview.parents[0].sha = 'f'.repeat(40); },
    f => { f.preview.parents[1].sha = 'f'.repeat(40); },
    f => { f.pr.merge_commit_sha = 'f'.repeat(40); },
    f => { f.commit.tree.sha = 'f'.repeat(40); },
    f => { f.input.context.reader.get = async () => {
      throw new Error('unavailable');
    }; },
  ];
  for (const mutate of mutations) {
    const f = reconciliationFixture();
    mutate(f);
    assert.equal((await observe(f)).status, 'pending', mutate.toString());
    assert.equal(f.counts.released, 1);
  }
});

test('unproven stage and lost settlement stay Pending', async () => {
  const unsupported = reconciliationFixture();
  unsupported.input.stage = 'deliver';
  assert.equal((await observe(unsupported)).status, 'pending');
  assert.equal(unsupported.counts.acquired, 1);
  const f = reconciliationFixture();
  f.dependencies.containers = async () => {
    if (++f.counts.settled === 2) throw new Error('Container appeared');
  };
  assert.equal((await observe(f)).status, 'pending');
  assert.equal(f.counts.released, 0);
});

test('a real journal with unknown external effects is never recovered by observation',
  async t => {
    const f = reconciliationFixture();
    const root = await mkdtemp(join(tmpdir(), 'nibfin-reconciliation-journal-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const journal = new OperationJournal(root, f.input.approval.record.issue);
    const request = { operation: 'close', bindingHash: 'e'.repeat(64) };
    await journal.run(request, { admit: async () => request.bindingHash,
      perform: async () => { throw new Error('Lost external response'); },
      readBack: async () => request.bindingHash });
    f.dependencies.journal = journal;
    assert.equal((await observe(f)).status, 'pending');
    await assert.rejects(journal.assertIdle(), /EXTERNAL_EFFECT_UNKNOWN/);
    assert.equal(f.counts.released, 0);
  });

test('integrity-checked receipt corruption stays Pending', async t => {
  const f = reconciliationFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-reconciliation-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvidenceStore(root, f.binding);
  for (const value of f.objects.values()) await store.put(value);
  for (const receipt of Object.values(f.receipts)) await store.append(receipt);
  f.dependencies.progress = async () => ({ store, binding: f.binding });
  assert.equal((await observe(f)).status, 'completed');
  const path = join(root, `evidence-${digest(f.binding)}`, digest(f.receipts.close));
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ ...f.receipts.close, outcome: 'blocked' }));
  assert.equal((await observe(f)).status, 'pending');
});

test('settled review correction preserves its terminal outcome and evidence', async t => {
  for (const stage of ['continue', 'review-pr']) {
    const f = await premergeFixture(t, stage);
    const first = await observe(f);
    assert.deepEqual(first, { ...f.result, stage, terminalStage: 'review-pr',
      recoveredResult: true, resultHash: (await f.evidence.read()).hash });
    assert.deepEqual(await observe(f), first);
    assert.equal(f.counts.released, 2);
    assert.equal(Object.hasOwn(first, 'retrySettled'), false);
  }
});

test('pre-merge binding and current evidence must remain exact', async t => {
  const mutations = [
    f => { f.input.runner.attempt++; },
    f => { f.input.runner.runId++; },
    f => { f.input.runner.jobId++; },
    f => { f.input.runner.memberId++; },
    f => { f.input.runner.repositoryId++; },
    f => { f.input.runner.sourceCommit = 'f'.repeat(40); },
    f => { f.input.execution.id = 'foreign'; },
    f => { f.binding.sourceHash = 'f'.repeat(64); },
    f => { f.pr.head.sha = 'f'.repeat(40); },
    f => { f.pr.node_id = 'foreign'; },
    f => { f.pr.number++; },
    f => { f.pr.base.repo.id++; },
    f => { f.pr.head.repo.id++; },
    f => { f.pr.state = 'closed'; },
    f => { f.commit.tree.sha = 'f'.repeat(40); },
    f => { f.live.node_id = 'foreign'; },
    f => { f.receipts['review-pr'].outcome = 'approved'; },
    f => { delete f.receipts.accept; },
  ];
  for (const mutate of mutations) {
    const f = await premergeFixture(t);
    mutate(f);
    assert.equal((await observe(f)).status, 'pending', mutate.toString());
  }
});

test('missing result and every unsettled observation stay unresolved', async t => {
  for (const fault of ['missing', 'unsettled', 'write', 'container', 'adoption',
    'release', 'recheck']) {
    const f = await premergeFixture(t);
    if (fault === 'missing') {
      await rm(join(f.evidence.directory, f.evidence.name));
    } else if (fault === 'unsettled') await f.evidence.begin();
    else if (fault === 'write') f.dependencies.journal.assertIdle = async () => {
      throw new Error('pending external write');
    };
    else if (fault === 'container') f.dependencies.containers = async () => {
      throw new Error('unobserved execution');
    };
    else if (fault === 'adoption') f.dependencies.inspect = async () => {
      throw new Error('adoption changed');
    };
    else if (fault === 'release') f.dependencies.acquire = async () => ({
      inspect: async () => {}, release: async () => { throw new Error('release'); },
    });
    else f.dependencies.containers = async () => {
      if (++f.counts.settled === 2) throw new Error('new execution');
    };
    const result = await observe(f);
    assert.equal(result.status, 'pending', fault);
    assert.equal(result.recoveredResult, undefined);
  }
});

test('a final repair result cannot be replaced by an earlier review', async t => {
  const f = await premergeFixture(t);
  const execution = hostExecution(f.input.runner, 'deliver', 1);
  const result = { schemaVersion: 1, stage: 'deliver', status: 'denied',
    code: 'CORRECTION_DID_NOT_CHANGE_CANDIDATE' };
  const calls = [];
  const final = await continueStages({
    store: f.store, inspect: async () => {}, wait: async () => {},
    execute: async stage => {
      calls.push(stage);
      return result;
    },
  });
  assert.deepEqual(calls, ['deliver']);
  assert.deepEqual(final, result);
  await f.save(final, execution, 1);
  const recovered = await observe(f);
  assert.equal(recovered.terminalStage, 'deliver');
  assert.equal(recovered.code, result.code);
  assert.equal(recovered.receiptHash, undefined);
  f.receipts.deliver.execution = hostExecution(f.input.runner, 'deliver', 2);
  assert.equal((await observe(f)).status, 'pending');
});

test('foreign terminal execution cannot be laundered through a result', async t => {
  const f = await premergeFixture(t);
  f.receipts['review-pr'].execution = hostExecution({ ...f.input.runner,
    attempt: 2 }, 'review-pr');
  f.result.receiptHash = digest(f.receipts['review-pr']);
  await f.save();
  assert.equal((await observe(f)).status, 'pending');
});

test('settled continuation binds an existing correction to its request', async t => {
  const f = await premergeFixture(t);
  const result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
    code: 'STAGE_REQUIRES_CORRECTION' };
  await f.evidence.begin();
  const hash = await f.evidence.record(result, f.input.execution, 0, 'shape');
  await f.evidence.settle(hash);
  const recovered = await observe(f);
  assert.equal(recovered.terminalStage, 'review-pr');
  assert.equal(recovered.status, 'denied');
  assert.equal(recovered.resultHash, hash);
  assert.equal(recovered.retrySettled, undefined);
});


test('lost continuation observation responses preserve the concrete terminal stage',
  async t => {
    for (const [target, status] of [
      ['review-pr', 404], ['review-pr', 503], ['merge', 404], ['merge', 503],
    ]) {
      const f = await premergeFixture(t);
      if (target === 'merge') f.receipts['review-pr'].outcome = 'approved';
      else delete f.receipts['review-pr'];
      let terminalStage;
      let released = false;
      let clock = 0;
      const run = () => continueStages({
        store: f.store,
        onStage: stage => { terminalStage = stage; },
        inspect: async () => {
          throw Object.assign(new Error('private'), { status,
            transientGitHubRead: status === 503 });
        },
        execute: () => assert.fail('Observation must precede execution'),
        clock: () => clock,
        wait: async delay => { clock += delay; },
      });
      await f.evidence.begin();
      const result = await settleHostStage(run, value => releaseControllerResult({
        evidence: f.evidence, result: value, execution: f.input.execution,
        executionStage: 'shape', release: async () => { released = true; },
      }), () => {}, () => terminalStage);
      assert.equal(released, true);
      assert.equal(result.stage, target);
      assert.equal(result.status, status === 404 ? 'denied' : 'pending');
      assert.equal(result.code, status === 404
        ? 'LIVE_OBSERVATION_HTTP_404' : 'GITHUB_READ_RETRY_PENDING');
      assert.equal(result.retrySettled, status === 404 ? undefined : true);
      const recovered = await observe(f);
      assert.equal(recovered.recoveredResult, true);
      assert.equal(recovered.terminalStage, target);
      assert.equal(recovered.status, result.status);
      assert.equal(recovered.code, result.code);
      assert.equal(recovered.retrySettled, undefined);
      assert.equal(recovered.resultHash, (await f.evidence.read()).hash);
      const request = { command: 'stage', stage: 'continue' };
      const calls = [];
      const relayed = await relayControllerRequest(request, 999,
        async (_, __, options) => {
          calls.push(JSON.parse(options.input));
          if (calls.length === 1) throw new Error('response lost');
          return { stdout: Buffer.from(JSON.stringify(await observe(f))) };
        });
      assert.deepEqual(relayed, recovered);
      assert.deepEqual(calls, [request, { ...request, command: 'reconcile-stage' }]);
    }
  });


test('merge-stage recovery requires an open published PR and no merge effects',
  async t => {
    const mutations = [
      f => { f.pr.merged = true; },
      f => { f.pr.state = 'closed'; },
      f => { f.pr.head.sha = 'f'.repeat(40); },
      f => { delete f.receipts['commit-pr']; },
      f => { f.result.status = 'completed'; },
      f => { f.receipts.merge = { ...f.receipts['review-pr'], stage: 'merge' }; },
      f => { f.receipts.close = { ...f.receipts['review-pr'], stage: 'close' }; },
    ];
    for (const mutate of mutations) {
      const f = await premergeFixture(t);
      f.receipts['review-pr'].outcome = 'approved';
      f.result = { schemaVersion: 1, stage: 'merge', status: 'denied',
        code: 'LIVE_OBSERVATION_HTTP_404' };
      mutate(f);
      await f.save(f.result, f.input.execution);
      const result = await observe(f);
      assert.equal(result.code, 'CONTROLLER_RECONCILIATION_UNPROVEN',
        mutate.toString());
      assert.equal(result.recoveredResult, undefined);
    }
  });
