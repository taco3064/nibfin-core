import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { continueStages } from '../src/stage-continuation.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { StageRuntime, stageSuccess } from '../src/stage-runtime.mjs';
import { stages } from '../src/stages.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

const linux = { skip: process.platform !== 'linux' };

test('retained-PR integration resumes local work and affected checks after interruption',
  linux, async t => {
    const scratch = fileURLToPath(new URL('../.deliver-test-tmp/', import.meta.url));
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(scratch, '576-integration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = stageFixture('deliver');
    const receipts = structuredClone(original.receipts);
    delete receipts['review-pr'];
    delete receipts.merge;
    const objects = new Map([
      [original.shape.hash, original.shape.body],
      [digest(original.candidate), original.candidate],
      ...Object.values(receipts).map(receipt => [digest(receipt), receipt]),
    ]);
    const store = {
      load: async () => structuredClone(receipts),
      get: async hash => structuredClone(objects.get(hash)),
      append: async receipt => {
        receipts[receipt.stage] = receipt;
        objects.set(digest(receipt), receipt);
        return digest(receipt);
      },
    };
    const calls = [];
    const currentMain = '9'.repeat(40);
    const publishedPr = { id: original.pr.id, number: original.pr.number };
    let candidate = original.candidate;
    let execution = original.execution;
    let repaired = false, fail = true, updates = 0, inspection = 0;
    const context = stage => {
      const value = stageFixture(stage);
      value.receipts = structuredClone(receipts);
      value.candidate = candidate;
      value.main.head = currentMain;
      value.pr.base = repaired ? currentMain : original.pr.base;
      value.ci.base = value.pr.base;
      if (stage === 'deliver') value.execution = structuredClone(execution);
      value.isolation.executionId = value.execution.id;
      return value;
    };
    const journal = new OperationJournal(root, original.approval.record.issue);
    const runtime = new StageRuntime({
      observe: async () => context('deliver'), journal, receipts: store,
      clock: () => now,
      handlers: { deliver: {
        perform: async value => {
          assert.equal(value.rebaseTarget, currentMain);
          assert.equal(value.pr.id, publishedPr.id);
          assert.equal(value.pr.number, publishedPr.number);
          if (fail)
            throw Object.assign(new Error('private local detail'), { code: 'EIO' });
          candidate = { ...original.candidate, base: currentMain,
            tree: 'a'.repeat(40), diffHash: 'b'.repeat(64) };
          objects.set(digest(candidate), candidate);
          repaired = true;
        },
        readBack: async () => ({ outcome: 'ready', findings: [],
          references: ['fixture:controlled-integration'], artifacts: {
            shapeHash: original.shape.hash, candidateHash: digest(candidate),
          } }),
      } },
    });
    // Provider observations and the retained-PR writer are controlled adapters.
    // The stage selection, local execution and journal settlement are real.
    const execute = async stage => {
      calls.push(stage);
      if (stage === 'deliver') {
        execution = { ...original.execution, id: randomUUID(), sessionId: randomUUID() };
        return runtime.run({ schemaVersion: 1, stage });
      }
      if (stage === 'review-pr' && !repaired)
        return { stage, status: 'denied', code: 'PR_MERGE_CONFLICT' };
      assert.ok(!['shape', 'validate-shape', 'publish-shape'].includes(stage));
      const value = context(stage);
      if (stage === 'commit-pr') {
        assert.deepEqual({ id: value.pr.id, number: value.pr.number }, publishedPr);
        updates++;
      }
      const source = original.receipts[stage] ?? original.receipts.merge;
      const receipt = { ...structuredClone(source), stage,
        outcome: stageSuccess[stage], execution: value.execution,
        artifacts: { ...source.artifacts, candidateHash: digest(candidate) } };
      if (['commit-pr', 'review-pr', 'merge', 'close'].includes(stage))
        receipt.artifacts.base = currentMain;
      if (['review-pr', 'merge', 'close'].includes(stage))
        receipt.artifacts.ciHash = digest(value.ci);
      if (stage === 'close') receipt.artifacts.mergeCommit = '8'.repeat(40);
      return { stage, status: 'completed', receiptHash: await store.append(receipt) };
    };
    const options = { store, execute, inspect: async () => { inspection++; },
      wait: async () => assert.fail('No synthetic CI wait is needed') };
    const first = await continueStages(options);
    assert.equal(first.stage, 'deliver');
    assert.equal(first.code, 'LOCAL_DELIVER_INTERRUPTED');
    assert.equal(first.localInterruption.phase, 'perform');
    assert.equal(first.localInterruption.cause, 'EIO');
    assert.deepEqual(calls, ['review-pr', 'deliver']);
    assert.equal(updates, 0);
    await journal.assertIdle();
    fail = false;
    const result = await continueStages(options);
    assert.equal(result.stage, 'close');
    assert.equal(result.status, 'completed');
    assert.equal(candidate.base, currentMain);
    assert.equal(updates, 1, 'Only the changed retained branch needs publication');
    assert.equal(calls.filter(stage => stage === 'deliver').length, 2);
    for (const stage of ['pre-accept-hooks', 'accept', 'post-accept-hooks'])
      assert.equal(calls.filter(name => name === stage).length, 1);
    assert.equal(receipts['commit-pr'].artifacts.prId, publishedPr.id);
    assert.equal(receipts['commit-pr'].artifacts.prNumber, publishedPr.number);
    assert.ok(inspection > 0);
    const count = calls.length;
    assert.equal((await continueStages(options)).code, 'DELIVERY_ALREADY_RECORDED');
    assert.equal(calls.length, count);
  });

test('a fresh local interruption does not add an internal retry loop', async () => {
  const original = stageFixture('deliver');
  const receipts = Object.fromEntries(Object.entries(original.receipts)
    .filter(([stage]) => Object.keys(stages).indexOf(stage) < 3));
  let calls = 0;
  const expected = { stage: 'deliver', status: 'pending',
    code: 'LOCAL_DELIVER_INTERRUPTED', localInterruption: {
      owner: 'core-local-deliver', phase: 'perform', cause: 'JOB_VM_CANCELLED',
    } };
  const result = await continueStages({
    store: { load: async () => receipts,
      get: async hash => hash === original.shape.hash ? original.shape.body : undefined },
    execute: async stage => { calls++; assert.equal(stage, 'deliver'); return expected; },
    inspect: async () => {}, wait: async () => assert.fail('No internal retry'),
  });
  assert.deepEqual(result, expected);
  assert.equal(calls, 1);
});
