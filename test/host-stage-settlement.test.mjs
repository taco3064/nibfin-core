import { hostMemoryPressure, pressureStages } from '../src/host-memory-pressure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleHostStage, hostPreparationSettlement }
  from '../src/host-stage-settlement.mjs';
import { githubApiWaiting, githubReadWaiting }
  from '../src/observation-failure.mjs';
import { ciCorrectionWaiting, ciLogsWaiting } from '../src/ci-recovery.mjs';

test('transient GitHub reads become retryable only after release', async () => {
  const pending = { status: 'pending', code: githubReadWaiting, retryAfterMs: 0 };
  let released = false;
  const settled = await settleHostStage(async () => pending,
    async () => { released = true; }, () => {});
  assert.equal(released, true);
  assert.equal(settled.retrySettled, true);
  const unresolved = await settleHostStage(async () => pending,
    async () => { throw new Error('unresolved'); }, () => {});
  assert.equal(unresolved.retrySettled, undefined);
  assert.equal(unresolved.code, 'HOST_EXECUTION_UNRESOLVED');
});

test('a read timeout releases the fence after local proof', async () => {
  const reports = [];
  let released = false;
  const result = await settleHostStage(
    async () => { throw new DOMException('private provider detail', 'TimeoutError'); },
    async () => { released = true; },
    (...values) => reports.push(values),
  );
  assert.equal(released, true);
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'LIVE_OBSERVATION_TIMEOUT');
  assert.deepEqual(reports, [['execution', 'LIVE_OBSERVATION_TIMEOUT']]);
});

test('the host proves settlement before retrying CI or corrective Deliver', async () => {
  for (const code of ['CI_WAITING', ciLogsWaiting, ciCorrectionWaiting,
    githubApiWaiting]) {
    const pending = { status: 'pending', code };
    let released = false;
    const result = await settleHostStage(async () => pending,
      async () => { released = true; }, () => {});
    assert.ok(released);
    assert.equal(result.retrySettled, true);
    const unknown = await settleHostStage(async () => pending, async () => {
      throw Object.assign(new Error('unknown'), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
    }, () => {});
    assert.equal(unknown.code, 'EXTERNAL_EFFECT_UNKNOWN');
    assert.equal(unknown.retrySettled, undefined);
  }
});

test('an unresolved operation retains the fence', async () => {
  const pending = { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
  const result = await settleHostStage(
    async () => pending,
    async () => assert.fail('Release must not be attempted'),
    () => {},
  );
  assert.equal(result, pending);
});

test('failure to establish local settlement keeps the run Pending', async () => {
  const result = await settleHostStage(
    async () => { throw new Error('Read failed'); },
    async () => { throw new Error('Local state cannot be confirmed'); },
    () => {},
  );
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'HOST_EXECUTION_UNRESOLVED');
});

test('generic pending results and forged preparation flags cannot settle', async () => {
  const result = { status: 'pending', code: 'LIVE_OBSERVATION_UNAVAILABLE',
    preparationSettled: true, preWorker: true, retrySettled: false };
  assert.equal(await settleHostStage(async () => result,
    () => assert.fail('Unclassified failure must retain the fence'), () => {}), result);
});


test('preparation settlement binds the original native execution', async () => {
  const execution = { id: 'original', runId: 20, attempt: 1, jobId: 30 };
  let releases = 0;
  const lifecycle = hostPreparationSettlement(execution,
    async () => { releases++; }, () => {});
  execution.runId = 21;
  const pending = { status: 'pending', code: 'LIVE_OBSERVATION_UNAVAILABLE' };
  const result = await lifecycle.settle(pending);
  assert.equal(result.status, 'pending');
  assert.equal(result.retrySettled, undefined);
  assert.deepEqual(result.preparationSettlement, { status: 'settled',
    execution: { id: 'original', runId: 20, attempt: 1, jobId: 30 } });
  lifecycle.enterOwnedWork();
  assert.equal(await lifecycle.settle(pending), pending);
  assert.equal(releases, 1);
});

test('confirmed stage pressure retries only after all effects settle', async () => {
  for (const stage of pressureStages) {
    const interrupted = { stage, status: 'denied', code: hostMemoryPressure,
      pressureConfirmed: true };
    const settled = await settleHostStage(async () => interrupted, async () => {},
      () => {});
    assert.equal(settled.retrySettled, true);
    for (const code of ['EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED',
      'PREVIOUS_HOST_PROCESS_UNRESOLVED', 'JOURNAL_CORRUPT']) {
      const pending = await settleHostStage(async () => interrupted, async () => {
        throw Object.assign(new Error(code), { code });
      }, () => {});
      assert.equal(pending.status, 'pending');
      assert.equal(pending.code, code);
      assert.equal(pending.retrySettled, undefined);
    }
    const unconfirmed = await settleHostStage(async () => ({ ...interrupted,
      pressureConfirmed: false }), async () => {}, () => {});
    assert.equal(unconfirmed.retrySettled, undefined);
  }
});
