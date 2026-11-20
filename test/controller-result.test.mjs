import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { issueStatePath } from '../src/host-fence.mjs';
import { controllerRequestIdentity, recordControllerResult }
  from '../src/controller-result.mjs';
import { hostExecution } from '../src/host-execution.mjs';
import { relayControllerRequest } from '../src/host-relay.mjs';
import { reconcileDelivery } from '../src/stage-reconciliation.mjs';
import { settleHostStage } from '../src/host-stage-settlement.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { reconciliationFixture } from './reconciliation-fixture.mjs';

function openFixture() {
  const f = reconciliationFixture();
  delete f.receipts.close;
  delete f.receipts.merge;
  Object.assign(f.live, { state: 'open', body: 'synthetic approved Shape',
    labels: [{ name: 'scope' }, { name: 'shaped' }] });
  Object.assign(f.pr, { state: 'open', merged: false });
  const { runner, approval, stage, execution } = f.input;
  runner.runnerId = 108;
  runner.target = { repositoryId: approval.record.issue.repositoryId };
  const request = controllerRequestIdentity(
    approval.record.issue, runner, stage, execution,
  );
  let reference = null;
  Object.assign(f.store, {
    loadStage: async name => structuredClone(f.receipts[name] ?? null),
    put: async value => f.put(value),
    readControllerResult: async () => reference,
    replaceControllerResult: async value => { reference = value; },
  });
  const fence = { inspect: async () => {} };
  const record = (result, producer, observed) => recordControllerResult({
    store: f.store, binding: f.binding, request, producer, result, observed, fence,
  });
  return { ...f, record, fence };
}

function recover(f) {
  return reconcileDelivery(f.input, f.dependencies);
}

function stageProducer(f, stage, iteration) {
  return { stage, iteration, execution: hostExecution(f.input.runner, stage, iteration) };
}

async function loseResponse(f, run, fault, reenter) {
  const calls = [];
  const result = await relayControllerRequest({ command: 'stage', stage: f.input.stage },
    999, async (_, __, { input }) => {
      const { command } = JSON.parse(input);
      calls.push(command);
      if (command === 'reconcile-stage')
        return { stdout: Buffer.from(JSON.stringify(await recover(f))) };
      if (calls.length > 1) return {
        stdout: Buffer.from(JSON.stringify(await reenter())),
      };
      await run();
      if (fault === 'transport') throw new Error('private stderr');
      return { stdout: Buffer.from(fault === 'json' ? '{' : '{}') };
    });
  return { result, calls };
}

test('lost correction-loop response preserves actual stage and producing iteration',
  async () => {
    const f = openFixture();
    const producer = stageProducer(f, 'deliver', 2);
    f.receipts['review-pr'].outcome = 'changes_required';
    const executed = [];
    const { result, calls } = await loseResponse(f, () => settleHostStage(
      async () => ({
        ...await continueStages({
          store: f.store, inspect: async () => {}, wait: async () => {},
          execute: async stage => {
            executed.push(stage);
            assert.equal(stage, producer.stage);
            const delivered = f.receipts.deliver;
            delivered.execution = producer.execution;
            return { stage, status: 'completed', receiptHash: f.put(delivered) };
          },
        }),
        privateToken: 'not-retained',
      }),
      value => f.record(value, producer),
      () => assert.fail('Unexpected settlement failure'),
    ), 'transport', () => assert.fail('Settled correction must not repeat'));
    assert.deepEqual(calls, ['stage', 'reconcile-stage']);
    assert.equal(result.stage, 'continue');
    assert.deepEqual(executed, ['deliver']);
    assert.equal(result.terminalStage, 'deliver');
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'CORRECTION_DID_NOT_CHANGE_CANDIDATE');
    assert.equal(result.disposition, 'recovered-result');
    assert.equal(Object.hasOwn(result, 'receiptHash'), false);
    const retained = f.objects.get(result.resultReference);
    assert.deepEqual(retained.producer, producer);
    assert.equal(Object.hasOwn(retained.response, 'privateToken'), false);
    assert.equal(f.counts.settled, 2);
  });

test('lost CI wait keeps retry settlement and never claims a missing Review receipt',
  async () => {
    const f = openFixture();
    delete f.receipts['review-pr'];
    const producer = stageProducer(f, 'review-pr', 1);
    const { result, calls } = await loseResponse(f, () => settleHostStage(
      async () => ({ stage: producer.stage, status: 'pending', code: 'CI_WAITING' }),
      value => f.record(value, producer),
      () => assert.fail('Unexpected settlement failure'),
    ), 'json', () => assert.fail('Pending result must not repeat the original request'));
    assert.deepEqual(calls, ['stage', 'reconcile-stage']);
    assert.equal(result.status, 'pending');
    assert.equal(result.terminalStage, 'review-pr');
    assert.equal(result.code, 'CI_WAITING');
    assert.equal(result.retrySettled, true);
    assert.equal(result.retryRun, f.input.runner.runId);
    assert.equal(result.retryAttempt, f.input.runner.attempt);
    assert.equal(Object.hasOwn(result, 'receiptHash'), false);
    assert.ok(f.reads.includes('/repos/owner/repo/pulls/444'));
  });

test('saved Review denial can retain publication without attributing a new execution',
  async () => {
    const f = openFixture();
    f.receipts['review-pr'].outcome = 'blocked';
    await f.record({ stage: 'review-pr', status: 'denied',
      code: 'STAGE_REQUIRES_CORRECTION' });
    const result = await recover(f);
    assert.equal(result.terminalStage, 'review-pr');
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
    assert.equal(f.objects.get(result.resultReference).producer, null);
    assert.ok(f.reads.includes('/repos/owner/repo/pulls/444'));
    f.pr.state = 'closed';
    assert.equal((await recover(f)).reason, 'CONTROLLER_RESULT_PUBLICATION_CHANGED');
  });

test('only successful absence can re-enter the original request once', async () => {
  for (const change of ['absent', 'new-attempt', 'changed-requirements', 'live-actor']) {
    const f = openFixture();
    const { result, calls } = await loseResponse(f, async () => {
      if (change !== 'absent') {
        const producer = stageProducer(f, 'accept', 1);
        await f.record({ stage: 'accept', status: 'denied',
          code: 'STAGE_REQUIRES_CORRECTION' }, producer);
      }
      if (change === 'new-attempt') {
        f.input.runner.attempt++;
        f.input.execution = hostExecution(f.input.runner, 'shape');
      }
      if (change === 'changed-requirements') f.live.body = 'changed owner requirements';
      if (change === 'live-actor') f.dependencies.containers = async () => {
        const reason = 'PREVIOUS_HOST_PROCESS_UNRESOLVED';
        throw Object.assign(new Error(reason), { code: reason });
      };
    }, 'json', () => ({ stage: 'continue', terminalStage: 'accept',
      status: 'completed', code: 'SYNTHETIC_REENTRY' }));
    const canReenter = ['absent', 'new-attempt'].includes(change);
    assert.deepEqual(calls, canReenter ? ['stage', 'reconcile-stage', 'stage'] :
      ['stage', 'reconcile-stage']);
    if (canReenter) assert.equal(result.code, 'SYNTHETIC_REENTRY');
    if (change === 'changed-requirements')
      assert.equal(result.reconciliationFailure,
        'CONTROLLER_RESULT_REQUIREMENTS_CHANGED');
    if (change === 'live-actor')
      assert.equal(result.reconciliationFailure, 'PREVIOUS_HOST_PROCESS_UNRESOLVED');
  }
});

test('exact authored Shape uses current author input and rejects changed receipts',
  async () => {
    const f = openFixture();
    delete f.receipts['publish-shape'];
    const producer = stageProducer(f, 'shape', 1);
    Object.assign(f.receipts.shape, { execution: producer.execution,
      requirementsBody: 'requirements at execution' });
    f.live.body = f.receipts.shape.requirementsBody;
    const receiptHash = f.put(f.receipts.shape);
    await f.record({ stage: 'shape', status: 'completed', code: 'STAGE_COMPLETED',
      receiptHash }, producer);
    const exact = await recover(f);
    assert.equal(exact.terminalStage, 'shape');
    assert.equal(exact.receiptHash, receiptHash);
    f.live.body += ' with new work';
    assert.equal((await recover(f)).reason, 'CONTROLLER_RESULT_REQUIREMENTS_CHANGED');
    f.live.body = f.receipts.shape.requirementsBody;
    f.receipts.shape.references.push('replacement path');
    assert.equal((await recover(f)).reason, 'CONTROLLER_RESULT_EVIDENCE_CHANGED');
  });

test('native completed delivery takes precedence over a broken pre-merge reference',
  async () => {
    const f = openFixture();
    const complete = reconciliationFixture();
    Object.assign(f.live, complete.live);
    Object.assign(f.pr, complete.pr);
    Object.assign(f.receipts, complete.receipts);
    f.store.readControllerResult = async () => {
      assert.fail('Dedicated completed-delivery path must not consult pre-merge data');
    };
    const result = await recover(f);
    assert.equal(result.terminalStage, 'close');
    assert.equal(result.status, 'completed');
  });

test('durable output survives a legacy marker and distinguishes corruption',
  { skip: process.platform !== 'linux' }, async t => {
    const parent = fileURLToPath(new URL('../.nibfin-cache/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'controller-result-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = openFixture();
    const { approval, runner, stage, execution, context } = f.input;
    const issue = approval.record.issue;
    const issueRoot = issueStatePath(root, issue);
    await mkdir(issueRoot, { mode: 0o700 });
    const store = new EvidenceStore(issueRoot, f.binding);
    const request = controllerRequestIdentity(issue, runner, stage, execution);
    context.host.stateRoot = root;
    f.dependencies.progress = async () => ({ store, binding: f.binding });
    await writeFile(join(issueRoot, 'stage.lock'), 'retired marker');
    assert.equal(await store.readControllerResult(), null);
    await store.replaceControllerResult(null);
    await recordControllerResult({ store, binding: f.binding, request,
      producer: stageProducer(f, 'deliver', 1),
      result: { stage: 'deliver', status: 'denied', code: 'STAGE_REQUIRES_CORRECTION' },
    });
    assert.equal((await recover(f)).terminalStage, 'deliver');
    const namespace = join(issueRoot, `evidence-${digest(f.binding)}`);
    const reference = await store.readControllerResult();
    const pointer = join(namespace, 'controller-result.json');
    await rm(join(namespace, reference));
    assert.equal((await recover(f)).reason, 'CONTROLLER_RESULT_EVIDENCE_MISSING');
    for (const bad of ['{', 'null']) {
      await writeFile(pointer, bad);
      assert.equal((await recover(f)).reason, 'CONTROLLER_RESULT_CORRUPT');
    }

    // A crash before result publication leaves clean absence.
    await store.replaceControllerResult(null);
    await store.put({ orphan: 'result object written before publication' });
    const later = await recover(f);
    assert.equal(later.disposition, 'unfinished');
    assert.equal(later.code, 'CONTROLLER_WORK_UNFINISHED');
  });
