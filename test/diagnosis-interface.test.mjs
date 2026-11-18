import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { consumerContract } from '../src/public-api.mjs';
import { safeDiagnosisResult } from '../src/diagnosis-plan.mjs';

const cli = new URL('../bin/nibfin-core.mjs', import.meta.url);

test('private CLI request rejects extra authority and never echoes its token', () => {
  const token = 'private-token-for-fixture';
  const result = spawnSync(process.execPath, [cli.pathname,
    'request-local-diagnosis'], { encoding: 'utf8', input: JSON.stringify({
    token, path: '/unrelated-host-data', diagnose: true }), timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'INVALID_DIAGNOSIS_REQUEST');
  assert.ok(!(result.stdout + result.stderr).includes(token));
  assert.equal(consumerContract.localWorkObservation.command, 'observe-local-work');
  assert.equal(consumerContract.localDiagnosis.command, 'request-local-diagnosis');
  assert.equal(consumerContract.localDiagnosis.executionAuthority, false);
});

test('diagnostic output excludes paths, logs and credential forms', () => {
  const valid = { explanation: 'The cause is unknown.',
    hypotheses: [], missing: ['Guest telemetry is unavailable.'] };
  assert.equal(safeDiagnosisResult(valid).confidence, 'attributed');
  for (const explanation of ['/auth/auth.json', 'https://private/log?sig=credential',
    'token: private-value', '{"raw":"log"}', 'a'.repeat(50)])
    assert.throws(() => safeDiagnosisResult({ ...valid, explanation }));
  assert.throws(() => safeDiagnosisResult({ ...valid, approved: true }));
});
