import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileDelivery } from '../src/stage-reconciliation.mjs';
import { hostExecution } from '../src/host-launcher.mjs';
import { issueStatePath } from '../src/host-fence.mjs';
import { acquireHostFence } from './legacy-stage-fence-fixture.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest } from '../src/identity.mjs';
import { reconciliationFixture } from './reconciliation-fixture.mjs';

const observe = f => reconcileDelivery(f.input, f.dependencies);

test('repeated settled observations return the same terminal receipt', async () => {
  const f = reconciliationFixture();
  const first = await observe(f);
  assert.deepEqual(first, { schemaVersion: 1, status: 'completed', stage: 'continue',
    terminalStage: 'close', receiptHash: digest(f.receipts.close) });
  assert.deepEqual(await observe(f), first);
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
    assert.equal(f.counts.settled, 4);
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

test('a legacy stage marker does not block or mutate a native observation', async t => {
  const f = reconciliationFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  f.input.context.host.stateRoot = root;
  const issue = f.input.approval.record.issue;
  const state = issueStatePath(root, issue);
  await mkdir(state, { mode: 0o700 });
  const fence = await acquireHostFence(state, { original: true });
  for (let observation = 0; observation < 2; observation++) {
    assert.equal((await observe(f)).status, 'completed');
    await fence.inspect();
  }
  assert.equal(f.reads.filter(read => read === 'issue').length, 4);
  await fence.release();
});

test('unknown effects and containers prevent settlement', async () => {
  for (const fault of ['EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED',
    'PREVIOUS_HOST_PROCESS_UNRESOLVED', 'JOURNAL_CORRUPT']) {
    const f = reconciliationFixture();
    const fail = async () => { throw Object.assign(new Error(fault), { code: fault }); };
    if (fault === 'PREVIOUS_HOST_PROCESS_UNRESOLVED') f.dependencies.containers = fail;
    else f.dependencies.journal.assertIdle = fail;
    assert.equal((await observe(f)).status, 'pending');
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
    assert.equal(f.counts.settled, 2);
  }
});

test('unsupported stage and lost settlement stay Pending', async () => {
  const unsupported = reconciliationFixture();
  unsupported.input.stage = 'unknown';
  assert.equal((await observe(unsupported)).status, 'pending');
  assert.equal(unsupported.counts.inspected, 0);
  const f = reconciliationFixture();
  f.dependencies.containers = async () => {
    if (++f.counts.settled === 2) throw new Error('Container appeared');
  };
  assert.equal((await observe(f)).status, 'pending');
  assert.equal(f.counts.settled, 2);
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
    assert.equal(f.counts.settled, 0);
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
