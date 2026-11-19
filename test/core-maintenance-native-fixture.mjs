// Called only inside the root fixture's private mount namespace.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chown, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkCoreMaintenance(module, context, host, binding) {
  const { admitCoreMaintenance, coreMaintenanceProvenance, requireCoreMaintenance,
    reobserveCoreMaintenance, observeCoreMaintenanceFrame } =
    await module('core-maintenance-identity.mjs');
  const { settleCoreOnlyWork, requireCoreOnlyListeners } =
    await module('core-only-settlement.mjs');
  const { withManagerAdmission } = await module('rollout-manager-admission.mjs');
  const { consumeManagedCredentials } = await module('managed-credentials.mjs');
  const { poolAdmission } = await module('retirement-admission.mjs');
  const { publishPrivate } = await module('managed-credential-files.mjs');
  const { observeCoreMaintenanceWorker } = await module('core-maintenance-worker.mjs');
  const { rolloutMarker } = await module('rollout-admission.mjs');
  const authHost = structuredClone(host);
  Object.assign(authHost.sharedRunner.caller, { ownerId: 6, ref: 'refs/heads/main',
    subject: 'repo:taco3064@6/nibfin-core@1:ref:refs/heads/main' });
  const root = '/repos/taco3064/nibfin-core';
  const sha = 'e'.repeat(40), target = { runId: 789, artifactId: 321 };
  const request = { runId: 123, attempt: 2, jobId: 456, runnerId: 42, target };
  const labels = ['self-hosted', 'nibfin-shared'];
  const guid = '12345678-1234-1234-1234-123456789abc';
  const native = { id: 42, name: 'slot-1', os: 'Linux', status: 'online', busy: true,
    labels: [...labels, 'nibfin-user-5'].map(name => ({ name })) };
  const run = { id: 123, run_attempt: 2, actor: { id: 88 },
    triggering_actor: { id: 89 }, status: 'in_progress', conclusion: null,
    event: 'workflow_dispatch', path: '.github/workflows/core-maintenance.yml',
    head_branch: 'main', head_sha: sha, repository: { id: 1 },
    head_repository: { id: 1 }, workflow_id: 70, pull_requests: [] };
  const job = { id: 456, run_id: 123, run_attempt: 2, head_sha: sha,
    status: 'in_progress', conclusion: null, name: 'core-maintenance',
    runner_id: 42, runner_name: 'slot-1', labels,
    check_run_url: `https://api.github.com${root}/check-runs/999` };
  const objects = new Map([
    [root, { id: 1, full_name: 'taco3064/nibfin-core', private: false,
      archived: false, disabled: false, owner: { id: 6 }, default_branch: 'main' }],
    [`${root}/branches/main`, { protected: true, commit: { sha } }],
    [`${root}/actions/runs/123/attempts/2`, run],
    [`${root}/actions/jobs/456`, job],
    [`${root}/actions/runs/123/attempts/2/jobs?per_page=100&page=1`,
      { total_count: 1, jobs: [job] }],
    [`${root}/actions/workflows/core-maintenance.yml`, { id: 70,
      path: run.path, state: 'active' }],
    [`${root}/actions/runners/42`, native],
    [`${root}/check-runs/999`, { id: 999, head_sha: sha,
      app: { slug: 'github-actions' }, name: job.name,
      status: 'in_progress', conclusion: null, external_id: guid }],
  ]);
  const second = { ...native, id: 43, name: 'slot-2', busy: false };
  let extraJob = false;
  const reader = {
    get: async path => {
      if (objects.has(path)) return structuredClone(objects.get(path));
      const repository = binding.repositories.find(value =>
        path === `/repos/${value.repository}`);
      assert.ok(repository, path);
      return { id: repository.repositoryId, full_name: repository.repository };
    },
    list: async path => {
      if (path === `${root}/actions/runners`) return [native, second];
      if (path === `${root}/actions/runs/123/jobs`)
        return extraJob ? [job, { ...job, id: 457 }] : [job];
      if (path.endsWith('/actions/runs?status=in_progress'))
        return path.startsWith(root + '/') ? [run] : [];
      throw new Error('Unexpected native listing ' + path);
    },
  };
  const now = Date.now(), issuer = 'https://token.actions.githubusercontent.com';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = { iss: issuer, aud: 'nibfin:core-maintenance',
    sub: authHost.sharedRunner.caller.subject, iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, jti: 'fixture',
    repository: 'taco3064/nibfin-core', repository_id: '1',
    repository_owner_id: '6', repository_visibility: 'public', run_id: '123',
    run_attempt: '2', actor_id: '88', check_run_id: '999',
    runner_environment: 'self-hosted', event_name: 'workflow_dispatch',
    workflow_ref: `taco3064/nibfin-core/${run.path}@refs/heads/main`,
    workflow_sha: sha, sha, ref: 'refs/heads/main', ref_type: 'branch' };
  const token = () => {
    const body = [{ typ: 'JWT', alg: 'RS256', kid: 'fixture' }, payload]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey)
      .toString('base64url');
  };
  const identity = { now, fetcher: async url => Response.json(url.endsWith('/jwks') ?
    { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture',
      use: 'sig', alg: 'RS256' }] } :
    { issuer, jwks_uri: `${issuer}/.well-known/jwks` }) };
  const admit = (supplied = {}, uid = host.runnerUid) =>
    admitCoreMaintenance(context, authHost, { ...request, token: token(), ...supplied },
      uid, reader, identity);
  const scope = await admit();
  const frameGithub = { run_id: '123', run_attempt: '2', workflow_sha: sha, sha,
    repository: 'taco3064/nibfin-core', repository_id: '1', ref: 'refs/heads/main',
    actor_id: '88', event_name: 'workflow_dispatch',
    workflow_ref: payload.workflow_ref };
  const frame = { jobId: guid, jobDisplayName: 'core-maintenance', contextData: {
    github: { t: 2, d: Object.entries(frameGithub).map(([k, v]) => ({ k, v })) } } };
  const observed = await observeCoreMaintenanceFrame(context, authHost, frame,
    host.runnerUid, reader);
  assert.deepEqual(observed, coreMaintenanceProvenance(scope, context));
  assert.throws(() => requireCoreMaintenance(observed, context),
    { code: 'CORE_MAINTENANCE_NOT_ADMITTED' });
  await assert.rejects(observeCoreMaintenanceFrame(context, authHost,
    { ...frame, jobId: guid.replace('12345678', 'aaaaaaaa') }, host.runnerUid, reader),
  { code: 'SHARED_WORKER_JOB_IDENTITY_MISMATCH' });
  assert.equal(requireCoreMaintenance(scope, context, target).provenance.checkRunId, 999);
  assert.notEqual(run.actor.id, host.memberId);
  assert.notEqual(job.id, 999);
  for (const supplied of [{ attempt: 1 }, { runnerId: 43 }, { mode: 'core-only' }])
    await assert.rejects(admit(supplied));
  await assert.rejects(admit({}, host.uid),
    { code: 'CORE_MAINTENANCE_INVOKER_CHANGED' });
  for (const [object, key, bad] of [[run, 'event', 'issues'],
    [job, 'name', 'shared-stage'], [native, 'busy', false],
    [native, 'labels', [...labels, 'nibfin-user-999'].map(name => ({ name }))]]) {
    const saved = object[key];
    object[key] = bad;
    await assert.rejects(admit());
    object[key] = saved;
  }
  payload.runner_environment = 'github-hosted';
  await assert.rejects(admit(), { code: 'OIDC_CALLER_MISMATCH' });
  payload.runner_environment = 'self-hosted';
  const plan = { mode: 'core-only', administratorTarget: target,
    maintenanceInvocation: coreMaintenanceProvenance(scope, context),
    originalServices: [{ slot: 1, running: true }, { slot: 2, running: false }] };
  await observeCoreMaintenanceWorker(context, authHost, frame, host.runnerUid,
    reader);
  const protectedPlan = { ...plan, schemaVersion: 2, pin: host.installation.pin,
    binding, maintenanceInvocation: { ...plan.maintenanceInvocation, runId: 122,
      jobId: 455 } };
  const planPath = '/etc/nibfin/rollout-plan.json';
  const closurePath = '/etc/nibfin/rollout-admission.json';
  await writeFile(planPath, JSON.stringify(protectedPlan));
  await writeFile(closurePath, JSON.stringify(rolloutMarker(protectedPlan)));
  try {
    await observeCoreMaintenanceWorker(context, authHost, frame, host.runnerUid,
      reader);
    for (const previous of [undefined, { repository: 'old/other', repositoryId: 99 }]) {
      const rootPlan = { ...protectedPlan, maintenanceInvocation: previous };
      await writeFile(planPath, JSON.stringify(rootPlan));
      await observeCoreMaintenanceWorker(context, authHost, frame, host.runnerUid,
        reader);
      // Read-only Worker entry cannot grant settlement authority from a plan
      // with missing/stale auxiliary provenance. Fresh Root admission must run.
      await assert.rejects(reobserveCoreMaintenance(context, authHost, reader));
    }
    await writeFile(planPath, JSON.stringify(protectedPlan));
    const ordinary = { ...frame, jobDisplayName: 'shared-stage' };
    await assert.rejects(observeCoreMaintenanceWorker(context, authHost, ordinary,
      host.runnerUid, reader), { code: 'CORE_MAINTENANCE_FRAME_CHANGED' });
    // Entry has no authority for an operation target. Signed Root operation
    // still checks exact target before any promotion/write can use its scope.
    assert.throws(() => requireCoreMaintenance(scope, context,
      { ...target, artifactId: 322 }), { code: 'CORE_MAINTENANCE_TARGET_CHANGED' });
    await writeFile(planPath, JSON.stringify({ ...protectedPlan, mode: 'other' }));
    await assert.rejects(observeCoreMaintenanceWorker(context, authHost, frame,
      host.runnerUid, reader), { code: 'CORE_MAINTENANCE_CLOSURE_CHANGED' });
    await writeFile(planPath, JSON.stringify(protectedPlan));
    await writeFile(closurePath, '{"other":true}');
    await assert.rejects(observeCoreMaintenanceWorker(context, authHost, frame,
      host.runnerUid, reader), { code: 'CORE_MAINTENANCE_CLOSURE_CHANGED' });
  } finally {
    await rm(planPath);
    await rm(closurePath);
  }
  const fresh = await reobserveCoreMaintenance(context, authHost, reader,
    async () => structuredClone(plan));
  requireCoreMaintenance(fresh, context, target);
  const leases = () => readdir(join(host.tokenFile, '..'));
  const before = await leases();
  const settle = credentialScope => settleCoreOnlyWork(plan, context, scope,
    host, reader, binding, { credentialScope }, { containers: async () => {} });
  await withManagerAdmission(context, async credentialScope => {
    await settle(credentialScope);
    extraJob = true;
    await assert.rejects(settle(credentialScope), { code: 'RETIREMENT_JOB_PENDING' });
    extraJob = false;
    second.busy = true;
    await assert.rejects(settle(credentialScope), { code: 'RETIREMENT_NATIVE_BUSY' });
    second.busy = false;
    await poolAdmission(host, async () => {
      await assert.rejects(settle(credentialScope),
        { code: 'RETIREMENT_CONSUMER_PENDING' });
    });
    await consumeManagedCredentials(host, async () => {
      await assert.rejects(settle(credentialScope),
        { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
    }, { verify: async () => {} });
    const stage = join(host.stateRoot, 'stage.lock');
    await publishPrivate(stage, '{}', host);
    await assert.rejects(settle(credentialScope),
      { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
    await rm(stage);
    const issue = join(host.stateRoot, 'issue-1-584');
    const agent = join(issue, 'agent');
    const session = join(agent, 'session-' + 'a'.repeat(64));
    for (const directory of [issue, agent, session]) {
      await mkdir(directory, { mode: 0o700 });
      await chown(directory, host.uid, host.gid);
    }
    await publishPrivate(join(session, 'active.lock'), '{}', host);
    await assert.rejects(settle(credentialScope), { code: 'RETIREMENT_WRITER_PENDING' });
    await rm(issue, { recursive: true });
  });
  assert.deepEqual(await leases(), before);
  await requireCoreOnlyListeners(plan, async slot => ({
    ActiveState: slot === 1 ? 'active' : 'inactive' }));
  await assert.rejects(requireCoreOnlyListeners(plan, async () => ({
    ActiveState: 'active' })), { code: 'CORE_ONLY_LISTENER_STATE_CHANGED' });
}
