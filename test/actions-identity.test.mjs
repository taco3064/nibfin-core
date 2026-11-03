import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyActionsIdentity, requestActionsIdentity } from '../src/actions-identity.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://token.actions.githubusercontent.com', now = Date.parse('2026-11-03T12:00:00Z');
function fixture() {
  const expected = { repository: 'example/core', repositoryId: 10, ownerId: 20, runId: 30, attempt: 1, actorId: 40,
    checkRunId: 50, sourceCommit: 'a'.repeat(40), audience: 'nibfin:execution:fixture-uuid',
    subject: 'repo:example@20/core@10:ref:refs/heads/main', workflowRef: 'example/core/.github/workflows/nibfin.yml@refs/heads/main', ref: 'refs/heads/main' };
  const header = { typ: 'JWT', alg: 'RS256', kid: 'fixture-key' };
  const payload = { iss: issuer, aud: expected.audience, sub: expected.subject, iat: now / 1000 - 10, nbf: now / 1000 - 10, exp: now / 1000 + 290,
    jti: 'synthetic-token-id', repository: expected.repository, repository_id: '10', repository_owner_id: '20', repository_visibility: 'public',
    run_id: '30', run_attempt: '1', actor_id: '40', check_run_id: '50', runner_environment: 'self-hosted', event_name: 'workflow_dispatch',
    workflow_ref: expected.workflowRef, workflow_sha: expected.sourceCommit, sha: expected.sourceCommit, ref: expected.ref, ref_type: 'branch', head_ref: '', base_ref: '' };
  const keys = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' }] };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined);
    assert.ok([`${issuer}/.well-known/openid-configuration`, `${issuer}/.well-known/jwks`].includes(url));
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/jwks') ? keys : { issuer, jwks_uri: `${issuer}/.well-known/jwks` }) };
  };
  const token = () => { const body = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`; };
  return { expected, header, payload, keys, fetcher, calls, token };
}

test('GitHub-native signature and current exact job check identity establish caller provenance', async () => {
  const f = fixture(), proof = await verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now });
  assert.equal(proof.checkRunId, 50); assert.equal(proof.runId, 30); assert.match(proof.identityHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(proof, 'token'), false); assert.equal(f.calls.length, 2);
});

test('signed foreign jobs, forks, stale tokens, wrong audience/source and unexpected reusable workflows reject', async () => {
  for (const mutate of [f => { f.payload.check_run_id = '51'; }, f => { f.payload.run_attempt = '2'; },
    f => { f.payload.event_name = 'pull_request'; }, f => { f.payload.repository_id = '99'; },
    f => { f.payload.aud = 'nibfin:other'; }, f => { f.payload.workflow_sha = 'b'.repeat(40); },
    f => { f.payload.runner_environment = 'github-hosted'; }, f => { f.payload.exp = now / 1000; },
    f => { f.payload.iat = now / 1000 + 20; }, f => { f.payload.job_workflow_sha = 'b'.repeat(40); },
    f => { f.payload.sub = 'repo:foreign/core:ref:refs/heads/main'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }));
  }
});

test('unsigned or attacker-selected signing keys and duplicate key identities cannot verify', async () => {
  const f = fixture(), parts = f.token().split('.'); parts[2] = Buffer.alloc(256).toString('base64url');
  await assert.rejects(verifyActionsIdentity(parts.join('.'), f.expected, { fetcher: f.fetcher, now }), /OIDC_SIGNATURE_INVALID/);
  f.header.jku = 'https://attacker.invalid/keys';
  await assert.rejects(verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }), /UNTRUSTED_OIDC_HEADER/);
  delete f.header.jku; f.keys.keys.push(f.keys.keys[0]);
  await assert.rejects(verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }), /OIDC_KEY_NOT_UNIQUE/);
});

test('request credential goes only to the fixed GitHub token-service origin and redirects are forbidden', async () => {
  let requests = 0;
  const fetcher = async (url, options) => { requests++; assert.equal(new URL(url).searchParams.get('audience'), 'nibfin:fixture');
    assert.equal(options.headers.Authorization, 'Bearer fixture-request-token'); assert.equal(options.redirect, 'error');
    return { ok: true, text: async () => '{"value":"synthetic-token"}' }; };
  const options = { requestUrl: 'https://vstoken.actions.githubusercontent.com/token?api-version=2.0', requestToken: 'fixture-request-token', audience: 'nibfin:fixture' };
  assert.equal(await requestActionsIdentity(options, fetcher), 'synthetic-token');
  for (const requestUrl of ['https://actions.githubusercontent.com.attacker.invalid/token', 'http://vstoken.actions.githubusercontent.com/token',
    'https://credential@vstoken.actions.githubusercontent.com/token']) await assert.rejects(requestActionsIdentity({ ...options, requestUrl }, fetcher));
  assert.equal(requests, 1);
});
