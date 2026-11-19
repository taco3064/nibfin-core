import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { rolloutFailure, projectRolloutResult, readRolloutProcessResult }
  from '../src/core-rollout-result.mjs';
import { authorityResult } from './core-rollout-authority-fixture.mjs';

const secret = 'DO-NOT-PUBLISH-provider-token-url-body';

test('actual credential authority distinguishes known denials from typed API 422',
  async () => {
    const codes = { invalid: 'AUTHORITY_INVALID', member: 'MEMBER_MISMATCH',
      repository: 'REPOSITORY_MISMATCH', admin: 'ADMIN_REQUIRED', '401': 'UNAUTHORIZED' };
    for (const [kind, suffix] of Object.entries(codes)) {
      const result = await authorityResult(kind);
      assert.deepEqual(result,
        { status: 'denied', code: 'MANAGED_CREDENTIAL_' + suffix });
    }
    assert.deepEqual(await authorityResult('422'), { status: 'pending',
      code: 'GITHUB_API_RETRY_PENDING', githubApi: { kind: 'http', httpStatus: 422 } });
  });

test('producer preserves 585 API types; identity refusals are distinct', () => {
  for (const [fields, api] of [
    [{ status: 422 }, { kind: 'http', httpStatus: 422 }],
    [{ githubReadFailure: 'network' }, { kind: 'network' }],
    [{ githubReadFailure: 'invalid-response' }, { kind: 'invalid-response' }],
  ]) {
    const value = rolloutFailure({ githubApiRead: true, ...fields, message: secret,
      body: secret, token: secret });
    assert.deepEqual(value, { status: 'pending', code: 'GITHUB_API_RETRY_PENDING',
      githubApi: api });
    assert(!JSON.stringify(value).includes(secret));
  }
  for (const code of ['CORE_MAINTENANCE_INVOKER_CHANGED', 'OIDC_SIGNATURE_INVALID'])
    assert.deepEqual(rolloutFailure({ code, message: secret }),
      { status: 'denied', code });
  assert.equal(rolloutFailure(new TypeError(secret)).status, 'pending');
});

test('child results use exact status/exit matrix and safe optional diagnostics', () => {
  for (const [status, code] of [['denied', 1], ['unsupported', 1], ['pending', 2],
    ['installed', 0]]) {
    const input = { status, code: 'CORE_ONLY_MAINTENANCE_REQUIRED', token: secret,
      detail: secret };
    const value = readRolloutProcessResult(JSON.stringify(input), '', code);
    assert.equal(value.status, status);
    if (status !== 'installed') assert(!JSON.stringify(value).includes(secret));
    assert.equal(readRolloutProcessResult(JSON.stringify(input), '', 9).status,
      'pending');
  }
  for (const input of ['', secret, 'null', '[]', '{"status":{}}',
    '{"status":"constructor"}', '{"status":"other","token":"secret"}']) {
    assert.deepEqual(readRolloutProcessResult(input, '', 0),
      { status: 'pending', code: 'CORE_ROLLOUT_RESULT_UNAVAILABLE' });
  }
  assert.deepEqual(projectRolloutResult({ status: 'pending', code: 'READ_PENDING',
    githubApi: { kind: 'unexpected', token: secret } }),
  { status: 'pending', code: 'READ_PENDING' });
  const installed = readRolloutProcessResult(JSON.stringify({ status: 'installed',
    installation: 'complete', continuation: { status: 'pending',
      code: 'GITHUB_API_RETRY_PENDING', githubApi: { kind: 'http', httpStatus: 422,
        body: secret }, detail: secret } }), '', 0);
  assert.equal(installed.installation, 'complete');
  assert.equal(installed.continuation.githubApi.httpStatus, 422);
  assert(!JSON.stringify(installed).includes(secret));
});

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
for (const kind of ['422', 'network', 'invalid-response', 'uid', 'signature',
  'malformed', 'unsupported', 'installed-422', 'mixed', 'authority-invalid',
  'authority-member', 'authority-repository', 'authority-admin', 'authority-401',
  'authority-422']) {
  test(`Node publisher through Python and normal Root decoder: ${kind}`, {
    skip: !python && 'Python is unavailable in this assigned environment',
  }, () => {
    const process = spawnSync('python3', ['-B', 'test/core-rollout-transport-probe.py',
      globalThis.process.execPath, kind], { encoding: 'utf8' });
    const result = readRolloutProcessResult(process.stdout, process.stderr,
      process.status);
    assert.equal(result.status, kind === 'unsupported' ? 'unsupported' :
      kind.startsWith('installed-') || kind === 'mixed' ? 'installed' :
      ['uid', 'signature'].includes(kind) || kind.startsWith('authority-') &&
      kind !== 'authority-422' ? 'denied' : 'pending', process.stderr);
    assert(!JSON.stringify(result).includes(secret));
    if (kind === '422' || kind === 'authority-422')
      assert.equal(result.githubApi.httpStatus, 422);
    if (['network', 'invalid-response'].includes(kind))
      assert.equal(result.githubApi.kind, kind);
    if (kind === 'installed-422') {
      assert.equal(result.installation, 'complete');
      assert.equal(result.continuation.githubApi.httpStatus, 422);
    }
    if (kind === 'mixed') {
      assert.equal(result.installation, 'complete');
      assert.equal(result.continuation.code, undefined);
      assert.equal(result.continuation.results[0].runId, 61);
      assert.equal(result.continuation.results[1].id, 'I_2');
      assert.equal(result.continuation.results[1].stage, 'dispatch');
      assert.equal(result.continuation.results[1].code, 'GITHUB_API_RETRY_PENDING');
      assert.equal(result.continuation.results[1].githubApi.httpStatus, 422);
    }
  });
}
