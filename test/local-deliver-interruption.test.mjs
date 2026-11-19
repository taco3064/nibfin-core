import test from 'node:test';
import assert from 'node:assert/strict';
import { localDeliverInterruption, projectLocalInterruption }
  from '../src/local-deliver-interruption.mjs';
import { makeBlockerReport, projectBlockerReport } from '../src/blocker-report.mjs';
import { stageFixture } from './stage-fixture.mjs';

const secret = '/private/work/token.json Bearer: do-not-retain-this';
const observation = (phase, cause) => ({ owner: 'core-local-deliver', phase, cause });

test('local callback causes retain only known codes and fixed phases', () => {
  for (const [error, code] of [
    [Object.assign(new Error(secret), { code: 'EACCES' }), 'EACCES'],
    [new Error('INVALID_STAGE_READBACK'), 'INVALID_STAGE_READBACK'],
    [Object.assign(new Error(secret), { status: 503 }), 'LIVE_OBSERVATION_HTTP_503'],
    [Object.assign(new Error(secret), { name: 'TimeoutError' }),
      'LIVE_OBSERVATION_TIMEOUT'],
    [Object.assign(new Error(secret), { code: 'PR_MERGE_CONFLICT' }),
      'PR_MERGE_CONFLICT'],
    [Object.assign(new Error(secret), { code: 'JOB_VM_CANCELLED' }),
      'JOB_VM_CANCELLED'],
  ]) {
    const value = localDeliverInterruption('perform', error);
    assert.deepEqual(value, observation('perform', code));
    assert.deepEqual(projectLocalInterruption(value), value);
    assert.ok(!JSON.stringify(value).includes(secret));
  }
});

test('unknown, cyclic and hostile exception details remain unknown', () => {
  const cycle = new Error(secret);
  cycle.cause = cycle;
  const hostile = Object.defineProperty({}, 'code', {
    get: () => { throw new Error(secret); },
  });
  for (const error of [new Error(secret), { code: secret }, cycle, hostile, null]) {
    assert.deepEqual(localDeliverInterruption('read-back', error),
      observation('read-back', null));
  }
  const nested = new Error(secret, {
    cause: Object.assign(new Error(secret), { code: 'ENOSPC' }),
  });
  assert.equal(localDeliverInterruption('complete', nested).cause, 'ENOSPC');
});

test('native reports project local cause without untrusted exception payloads', () => {
  const context = stageFixture('deliver');
  const value = { ...observation('read-back', 'RECEIPT_PERSISTENCE_FAILED'),
    message: secret, stack: secret, headers: { Authorization: secret } };
  const report = makeBlockerReport(context, 'deliver', {
    producer: 'core-native', code: 'LOCAL_DELIVER_INTERRUPTED',
    localInterruption: value,
  });
  const projected = projectBlockerReport(report, {
    issue: context.approval.record.issue, subjectId: context.execution.actorId,
  });
  assert.deepEqual(projected.localInterruption,
    observation('read-back', 'RECEIPT_PERSISTENCE_FAILED'));
  assert.match(projected.rootCause, /read-back/);
  assert.match(projected.rootCause, /RECEIPT_PERSISTENCE_FAILED/);
  assert.ok(projected.confirmed.includes('LOCAL_OPERATION_CAUSE_CODE'));
  assert.equal(projected.executionAuthority, false);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(projected).includes(secret));
});

test('local phase is observed while an absent cause stays explicitly unavailable', () => {
  const context = stageFixture('deliver');
  const report = makeBlockerReport(context, 'deliver', {
    producer: 'core-native', code: 'LOCAL_DELIVER_INTERRUPTED',
    localInterruption: observation('complete', secret),
  });
  assert.deepEqual(report.localInterruption, observation('complete', null));
  assert.match(report.rootCause, /underlying cause is unknown/);
  assert.ok(report.missing.includes('LOCAL_OPERATION_CAUSE_UNAVAILABLE'));
  assert.ok(report.missing.includes('TERMINATION_TELEMETRY_UNAVAILABLE'));
  assert.equal(report.failureClass, null);
});

test('Agent or external-effect reports cannot claim a local journal observation', () => {
  const context = stageFixture('deliver');
  for (const options of [
    { producer: 'agent', code: 'LOCAL_DELIVER_INTERRUPTED' },
    { producer: 'core-native', code: 'EXTERNAL_EFFECT_UNKNOWN' },
  ]) {
    const report = makeBlockerReport(context, 'deliver', {
      ...options, localInterruption: observation('perform', 'EACCES'),
    });
    assert.equal(report.localInterruption, undefined);
    assert.equal(report.rootCause, null);
  }
  assert.equal(projectLocalInterruption({
    ...observation(secret, 'EACCES'),
  }), null);
});

test('projection never coerces non-string causes or retains their private fields', () => {
  let coerced = 0;
  const cause = { credential: 'secret-marker', toString: () => {
    coerced++;
    return 'LIVE_OBSERVATION_HTTP_503';
  } };
  for (const value of [cause, Symbol('secret-marker'), 503, true]) {
    assert.deepEqual(projectLocalInterruption(observation('perform', value)),
      observation('perform', null));
  }
  assert.equal(coerced, 0);
});

test('projection does not invoke accessors or proxies', () => {
  let accessed = 0;
  const getter = () => { accessed++; throw new Error(secret); };
  for (const property of ['owner', 'phase', 'cause']) {
    const value = Object.defineProperty(observation('perform', 'EACCES'), property,
      { get: getter });
    assert.deepEqual(projectLocalInterruption(value), property === 'cause'
      ? observation('perform', null) : null);
  }
  const proxy = new Proxy(observation('perform', 'EACCES'), {
    get: getter, getOwnPropertyDescriptor: getter,
  });
  assert.equal(projectLocalInterruption(proxy), null);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(projectLocalInterruption(revoked.proxy), null);
  const changing = Object.defineProperty(observation('perform', 'EACCES'), 'phase', {
    get: () => ++accessed === 1 ? 'perform' : secret,
  });
  assert.equal(projectLocalInterruption(changing), null);
  assert.equal(accessed, 0);
});

test('exception diagnostics do not evaluate accessor or proxy properties', () => {
  let accessed = 0;
  const getter = () => { accessed++; return 'EACCES'; };
  const accessor = Object.defineProperty({}, 'code', { get: getter });
  const proxy = new Proxy({}, { get: getter, getOwnPropertyDescriptor: getter });
  for (const error of [accessor, proxy])
    assert.deepEqual(localDeliverInterruption('perform', error),
      observation('perform', null));
  assert.equal(accessed, 0);
});

test('native report boundaries tolerate hostile interruption properties', () => {
  const context = stageFixture('deliver');
  let accessed = 0;
  const getter = () => { accessed++; throw new Error(secret); };
  const cause = { credential: 'secret-marker', toString: () => {
    accessed++;
    return 'LIVE_OBSERVATION_HTTP_503';
  } };
  const values = [observation('read-back', cause),
    observation('read-back', Symbol('secret-marker')),
    Object.defineProperty({}, 'owner', { get: getter }),
    Object.defineProperty(observation('read-back', null), 'cause', { get: getter }),
    new Proxy({}, { get: getter, getOwnPropertyDescriptor: getter })];
  for (const value of values) {
    const report = makeBlockerReport(context, 'deliver', {
      producer: 'core-native', code: 'LOCAL_DELIVER_INTERRUPTED',
      localInterruption: value,
    });
    const projected = projectBlockerReport(report, {
      issue: context.approval.record.issue, subjectId: context.execution.actorId,
    });
    assert.ok(!JSON.stringify([report, projected]).includes('secret-marker'));
    assert.ok(!JSON.stringify([report, projected]).includes(secret));
    assert.equal(projected.localInterruption?.cause ?? null, null);
  }
  assert.equal(accessed, 0);
});
