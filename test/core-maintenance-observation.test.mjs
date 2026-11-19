import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceOperationObservation, observeMaintenanceOperation }
  from '../src/core-maintenance-observation.mjs';

test('optional installed operation projection never exports private plan fields', () => {
  const pin = { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64) };
  const target = { runId: 31, artifactId: 44 };
  const value = maintenanceOperationObservation({ schemaVersion: 2,
    administratorTarget: { ...target, token: 'secret' },
    pin: { ...pin, secret: 'secret' },
    actionCommit: 'c'.repeat(40), token: 'secret' });
  assert.deepEqual(value, { operationTarget: target, operationSources: { core: pin,
    action: { repository: 'taco3064/nibfin-act', commit: 'c'.repeat(40) } } });
  assert.deepEqual(maintenanceOperationObservation(null), {});
});

test('optional bookkeeping cannot undo confirmed installation', async () => {
  for (const error of [new SyntaxError('secret body'),
    Object.assign(new Error('secret path'), { code: 'UNTRUSTED_RETIREMENT_FILE' })]) {
    const value = await observeMaintenanceOperation(async () => { throw error; });
    assert.equal(value.operation.status, 'pending');
    assert.ok(!JSON.stringify(value).includes('secret'));
  }
});
