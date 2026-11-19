import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/evidence-store.mjs';
import {
  ControllerResult, controllerRequest, releaseControllerResult,
} from '../src/controller-result.mjs';
import { settleHostStage } from '../src/host-stage-settlement.mjs';
import { hostExecution } from '../src/host-execution.mjs';
import { digest } from '../src/identity.mjs';
import { reconciliationFixture } from './reconciliation-fixture.mjs';

async function fixture(t) {
  const f = reconciliationFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-controller-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvidenceStore(root, f.binding);
  for (const value of f.objects.values()) await store.put(value);
  const request = controllerRequest({ ...f.input, binding: f.binding });
  const evidence = new ControllerResult(root, request, store);
  await evidence.begin();
  return { ...f, root, store, evidence, request };
}

test('final request result replaces an intermediate review after repairs', async t => {
  const f = await fixture(t);
  const execution = hostExecution(f.input.runner, 'deliver', 1);
  const result = { schemaVersion: 1, stage: 'deliver', status: 'denied',
    code: 'CORRECTION_DID_NOT_CHANGE_CANDIDATE' };
  let released = false;
  const actual = await settleHostStage(async () => result, value =>
    releaseControllerResult({ evidence: f.evidence, result: value, execution,
      iteration: 1, release: async () => { released = true; } }), assert.fail);
  assert.equal(released, true);
  assert.deepEqual(actual, result);
  const { record } = await f.evidence.read();
  assert.deepEqual(record.result, result);
  assert.deepEqual(record.execution, execution);
  assert.equal(record.iteration, 1);
});

test('write, release and settlement interruption windows remain unresolved', async t => {
  for (const phase of ['record', 'release', 'settle']) {
    const f = await fixture(t);
    const original = f.evidence[phase]?.bind(f.evidence);
    if (original) f.evidence[phase] = async () => { throw new Error(phase); };
    const result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
      code: 'STAGE_REQUIRES_CORRECTION' };
    let released = false;
    const actual = await settleHostStage(async () => result, value =>
      releaseControllerResult({ evidence: f.evidence, result: value,
        execution: hostExecution(f.input.runner, 'review-pr'),
        release: async () => {
          if (phase === 'release') throw new Error('HOST_FENCE_CHANGED');
          released = true;
        } }), () => {});
    assert.equal(actual.status, 'pending');
    assert.equal(released, phase === 'settle');
    await assert.rejects(f.evidence.read(), /CONTROLLER_RESULT_UNSETTLED/);
  }
});

test('new work invalidates an earlier same-request result before execution', async t => {
  const f = await fixture(t);
  const result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
    code: 'STAGE_REQUIRES_CORRECTION', secret: 'never persist' };
  await releaseControllerResult({ evidence: f.evidence, result,
    execution: hostExecution(f.input.runner, 'review-pr'), release: async () => {} });
  assert.equal(JSON.stringify(await f.evidence.read()).includes('never persist'), false);
  await f.evidence.begin();
  await assert.rejects(f.evidence.read(), /CONTROLLER_RESULT_UNSETTLED/);
});

test('unknown effects never release or create a settled result', async t => {
  const f = await fixture(t);
  const result = { schemaVersion: 1, stage: 'deliver', status: 'pending',
    code: 'EXTERNAL_EFFECT_UNKNOWN' };
  assert.deepEqual(await settleHostStage(async () => result,
    () => assert.fail('Must retain fence'), assert.fail), result);
  await assert.rejects(f.evidence.read(), /CONTROLLER_RESULT_UNSETTLED/);
});

test('corrupt durable result objects fail integrity validation', async t => {
  const f = await fixture(t);
  const hash = await f.evidence.record({ schemaVersion: 1, stage: 'review-pr',
    status: 'denied', code: 'STAGE_REQUIRES_CORRECTION' },
  hostExecution(f.input.runner, 'review-pr'));
  await f.evidence.settle(hash);
  const path = join(f.root, `evidence-${digest(f.binding)}`, hash);
  await chmod(path, 0o600);
  await writeFile(path, '{}');
  await assert.rejects(f.evidence.read(), /EVIDENCE_OBJECT_CORRUPT/);
});

test('a new request cannot race fence release and unfinished persistence', async t => {
  const f = await fixture(t);
  const other = new ControllerResult(f.root, f.request, f.store);
  const result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
    code: 'STAGE_REQUIRES_CORRECTION' };
  await releaseControllerResult({ evidence: f.evidence, result,
    execution: hostExecution(f.input.runner, 'review-pr'), release: async () => {
      await assert.rejects(other.begin(), { code: 'EEXIST' });
      await assert.rejects(other.read(), /CONTROLLER_RESULT_UNSETTLED/);
    } });
  assert.deepEqual((await other.read()).record.result, result);
});

test('failed invalidation cannot expose the previous settled response', async t => {
  const f = await fixture(t);
  const result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
    code: 'STAGE_REQUIRES_CORRECTION' };
  await releaseControllerResult({ evidence: f.evidence, result,
    execution: hostExecution(f.input.runner, 'review-pr'), release: async () => {} });
  f.evidence.write = async () => { throw new Error('disk failure'); };
  await assert.rejects(f.evidence.begin(), /disk failure/);
  await assert.rejects(f.evidence.read(), /CONTROLLER_RESULT_UNSETTLED/);
});
