// GitHub-issued token, native job read-back and actual signature verification.
// Neither a hosted nor a self-hosted push is protected stage admission evidence.
import assert from 'node:assert/strict';
import { requestActionsIdentity, verifyActionsIdentity } from '../src/actions-identity.mjs';

const env = process.env;
const selfHosted = env.GITHUB_JOB === 'self-hosted-identity';
assert.ok(selfHosted || env.GITHUB_JOB === 'oidc-boundary');
const jobName = selfHosted ? 'Real self-hosted identity boundary' : 'Real Actions identity boundary';
assert.equal(env.GITHUB_REPOSITORY, 'taco3064/nibfin-core');
assert.equal(env.GITHUB_EVENT_NAME, 'push');
assert.equal(env.GITHUB_REF, 'refs/heads/bootstrap/core-1-runtime');
const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
const audience = `nibfin:remote-identity-verification:${runId}:${attempt}`;
const token = await requestActionsIdentity({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience });
// Inspect only after the fixed verifier establishes signature validity below.
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
  redirect: 'error', signal: AbortSignal.timeout(15000),
  headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
});
assert.ok(response.ok, 'Native jobs unavailable');
const jobs = await response.json();
assert.ok(jobs.total_count <= 100, 'Unexpected job pagination');
const matches = jobs.jobs.filter(job => job.name === jobName && job.status === 'in_progress');
assert.equal(matches.length, 1);
const job = matches[0], checkPrefix = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/check-runs/`;
assert.ok(job.check_run_url.startsWith(checkPrefix));
const [owner, repositoryName] = env.GITHUB_REPOSITORY.split('/');
const expected = { audience, repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
  ownerId: Number(env.GITHUB_REPOSITORY_OWNER_ID), runId, attempt, actorId: Number(env.GITHUB_ACTOR_ID),
  checkRunId: Number(job.check_run_url.slice(checkPrefix.length)), sourceCommit: env.GITHUB_SHA,
  subject: `repo:${owner}@${env.GITHUB_REPOSITORY_OWNER_ID}/${repositoryName}@${env.GITHUB_REPOSITORY_ID}:ref:${env.GITHUB_REF}`, ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF };
// This exact error occurs after issuer metadata, key selection, cryptographic
// signature and token lifetime checks. No fallback or fabricated signing key.
await assert.rejects(verifyActionsIdentity(token, expected), { code: 'OIDC_CALLER_MISMATCH' });
for (const [key, value] of Object.entries({ aud: audience, sub: expected.subject, repository: expected.repository,
  repository_id: String(expected.repositoryId), repository_owner_id: String(expected.ownerId),
  run_id: String(runId), run_attempt: String(attempt), actor_id: String(expected.actorId),
  check_run_id: String(expected.checkRunId), workflow_ref: expected.workflowRef,
  workflow_sha: expected.sourceCommit, sha: expected.sourceCommit, ref: expected.ref,
  runner_environment: selfHosted ? 'self-hosted' : 'github-hosted', event_name: 'push' })) {
  // Do not print token claims or claim values on assertion failures.
  assert.ok(claims[key] === value, `Native identity field mismatch: ${key}`);
}
if (selfHosted) {
  assert.equal(job.runner_name, 'nibfin-remote-probe-20261103');
  assert.ok(Number.isSafeInteger(job.runner_id) && job.runner_id > 0);
  assert.deepEqual(job.labels, ['nibfin-remote-probe-20261103']);
}
assert.equal(job.head_sha, expected.sourceCommit);
assert.equal(job.run_id, runId);
assert.equal(job.run_attempt, attempt);
const parts = token.split('.');
parts[1] = Buffer.from(JSON.stringify({ ...claims, runner_environment: 'self-hosted', event_name: 'workflow_dispatch' })).toString('base64url');
await assert.rejects(verifyActionsIdentity(parts.join('.'), expected), { code: 'OIDC_SIGNATURE_INVALID' });
console.log(JSON.stringify({ status: 'passed', kind: 'real-actions-identity-boundary', runId, attempt,
  jobId: job.id, checkRunId: expected.checkRunId, sourceCommit: expected.sourceCommit,
  nativeSignatureVerified: true, runnerEnvironment: selfHosted ? 'self-hosted' : 'github-hosted',
  registeredRunnerObserved: selfHosted, runnerId: job.runner_id,
  pushEventDenied: true, hostedRunnerDenied: !selfHosted, tamperedTokenDenied: true,
  selfHostedRunnerBindingVerified: false }));
