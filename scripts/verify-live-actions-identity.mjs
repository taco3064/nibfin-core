// GitHub-issued token, native job read-back and actual signature verification.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import {
  requestActionsIdentity, verifyActionsIdentity,
} from '../src/actions-identity.mjs';

const env = process.env;
const selfHosted = env.GITHUB_JOB === 'self-hosted-identity';
assert.ok(selfHosted || env.GITHUB_JOB === 'oidc-boundary');
const jobName = selfHosted
  ? 'Real self-hosted identity boundary' : 'Real Actions identity boundary';
assert.equal(env.GITHUB_REPOSITORY, 'taco3064/nibfin-core');
const eventName = env.GITHUB_EVENT_NAME;
const manual = eventName === 'workflow_dispatch' && !selfHosted;
assert.ok(manual || eventName === 'push');
assert.equal(env.GITHUB_REF, manual
  ? 'refs/heads/main' : 'refs/heads/bootstrap/core-1-runtime');
const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
const audience = `nibfin:remote-identity-verification:${runId}:${attempt}`;
const token = await requestActionsIdentity({
  requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience,
});
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const api = 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY;
const jobsUrl = `${api}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
async function readCurrentJob() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(jobsUrl, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    assert.ok(response.ok, 'Native jobs unavailable');
    const jobs = await response.json();
    assert.ok(jobs.total_count <= 100, 'Unexpected job pagination');
    const matches = jobs.jobs.filter(job =>
      job.name === jobName && job.status === 'in_progress');
    assert.ok(matches.length <= 1, 'Ambiguous native probe job');
    if (matches.length === 1) return matches[0];
    await setTimeout(2000);
  }
  assert.fail('Native probe job never became visible as in progress');
}
const job = await readCurrentJob();
const checkPrefix = api + '/check-runs/';
assert.ok(job.check_run_url.startsWith(checkPrefix));
const [owner, repositoryName] = env.GITHUB_REPOSITORY.split('/');
const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
const ownerId = Number(env.GITHUB_REPOSITORY_OWNER_ID);
const subjectRepository = `repo:${owner}@${ownerId}/${repositoryName}@${repositoryId}`;
const expected = {
  audience, repository: env.GITHUB_REPOSITORY, repositoryId, ownerId,
  runId, attempt, actorId: Number(env.GITHUB_ACTOR_ID),
  checkRunId: Number(job.check_run_url.slice(checkPrefix.length)),
  sourceCommit: env.GITHUB_SHA,
  subject: `${subjectRepository}:ref:${env.GITHUB_REF}`,
  ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF,
};
// Keep admission expecting an installed self-hosted dispatch.
await assert.rejects(verifyActionsIdentity(token, expected), {
  code: 'OIDC_CALLER_MISMATCH',
});
const identity = {
  aud: audience, sub: expected.subject, repository: expected.repository,
  repository_id: String(repositoryId), repository_owner_id: String(ownerId),
  run_id: String(runId), run_attempt: String(attempt), actor_id: String(expected.actorId),
  check_run_id: String(expected.checkRunId), workflow_ref: expected.workflowRef,
  workflow_sha: expected.sourceCommit, sha: expected.sourceCommit, ref: expected.ref,
  runner_environment: selfHosted ? 'self-hosted' : 'github-hosted', event_name: eventName,
};
for (const [key, value] of Object.entries(identity)) {
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
const forged = {
  ...claims, runner_environment: 'self-hosted', event_name: 'workflow_dispatch',
};
parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url');
await assert.rejects(verifyActionsIdentity(parts.join('.'), expected), {
  code: 'OIDC_SIGNATURE_INVALID',
});
console.log(JSON.stringify({
  status: 'passed', kind: 'real-actions-identity-boundary', runId, attempt,
  jobId: job.id, checkRunId: expected.checkRunId, sourceCommit: expected.sourceCommit,
  nativeSignatureVerified: true, runnerEnvironment: identity.runner_environment,
  registeredRunnerObserved: selfHosted, runnerId: job.runner_id,
  pushEventDenied: !manual, hostedRunnerDenied: !selfHosted, tamperedTokenDenied: true,
  selfHostedRunnerBindingVerified: false,
}));
