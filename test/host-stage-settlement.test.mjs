import test from 'node:test';
import assert from 'node:assert/strict';
import { settleHostStage } from '../src/host-stage-settlement.mjs';
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
