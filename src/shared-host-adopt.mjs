import {
  retiredReplacement, releaseRetiredReplacement,
} from './retirement-rebind.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { createProviderBinding } from './provider-binding.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubReader, repoPath } from './github-read.mjs';
import { digest, gitBlob, isId, isSha, requireThat } from './identity.mjs';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { sharedSlotIsolation, sharedWorkflowPath } from './shared-runner.mjs';
import { inspectSharedHost, sharedHostRegistrations } from './shared-host-inspect.mjs';
import {
  observeAdoptionWorkflow, observePeer, peerConfiguration, verifyAdoptionAction,
  withSharedAdoptionLock,
} from './shared-peer-adoption.mjs';
import { dockerBackend, validDockerEndpoint } from './docker-backend.mjs';
import { command } from './process.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { installSharedRelay, prepareSharedAccounts } from './shared-host-setup.mjs';
import { prepareSharedGateways } from './shared-gateway-setup.mjs';

import { managedSharedAdmission, requireSharedBranch }
  from './shared-admission-policy.mjs';

const profileName = 'shared-host-profile.json';
const issueWorkflow = '.github/workflows/issue.yml';
const limit = 262144;

async function privatePath(path, uid, directory = false) {
  requireThat(typeof path === 'string' && await realpath(path) === path,
    'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
  const stat = await lstat(path);
  requireThat(stat.uid === uid && (stat.mode & 0o077) === 0 &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
  'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
}

async function accountUid(name) {
  await rootOwnedPath('/usr/bin/getent');
  const { stdout } = await command('/usr/bin/getent', ['passwd', name], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 4096,
  });
  const [observed, , uid] = stdout.toString().trim().split(':');
  requireThat(observed === name && isId(Number(uid)) && Number(uid) < 65536,
    'SHARED_HOST_ACCOUNT_INVALID');
  return Number(uid);
}

function validateIsolation(isolation, managed) {
  const backend = dockerBackend(isolation);
  requireThat(backend.mode === 'rootful' && isolation.agent && isolation.hooks &&
    [isolation.agent, isolation.hooks].every(config =>
      validDockerEndpoint(config, backend) && /^sha256:[0-9a-f]{64}$/.test(config.image)
    ) && (managed || /^[0-9a-f]{64}$/.test(isolation.agent.gatewayId)),
  'SHARED_HOST_ISOLATION_INVALID');
}

async function controllerProfile(profile) {
  const { stateRoot, tokenFile, authFile, model, isolation, secondaryIsolation,
    globalInstructionsFile, mcp, managedEgressNetwork } = profile;
  requireThat(profile.schemaVersion === 1 && isolation && secondaryIsolation &&
    typeof model === 'string' && model.length > 0 && model.length < 128 &&
    [stateRoot, tokenFile, authFile].every(path => typeof path === 'string') &&
    (managedEgressNetwork === undefined ||
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(managedEgressNetwork)),
  'SHARED_HOST_PROFILE_INVALID');
  const managed = managedEgressNetwork !== undefined;
  [isolation, secondaryIsolation].forEach(value => validateIsolation(value, managed));
  if (managed) {
    const firstPolicy = isolation.agent.mcpPolicyDirectory;
    const secondPolicy = secondaryIsolation.agent.mcpPolicyDirectory;
    requireThat(!firstPolicy || secondPolicy && secondPolicy !== firstPolicy,
      'SHARED_RUNNER_SLOT_ISOLATION_CONFLICT');
    await prepareSharedAccounts(profile);
  }
  const [uid, runnerUid, secondUid] = await Promise.all(
    ['nibfin-controller', 'nibfin-runner-1', 'nibfin-runner-2'].map(accountUid));
  for (const path of [stateRoot, dirname(tokenFile), dirname(authFile)])
    await privatePath(path, uid, true);
  for (const path of [tokenFile, authFile]) await privatePath(path, uid);
  return { uid, runnerUid, secondUid, stateRoot, tokenFile, authFile, model,
    isolation, secondaryIsolation, globalInstructionsFile, mcp, managedEgressNetwork };
}

export async function observeExecutionPool(reader, name, repoId, memberId, ids,
  source, actionCommit, workflow, sharedAdmission) {
  const root = repoPath(name);
  const observed = await observePeer(
    reader, name, repoId, memberId, source, actionCommit);
  const policyRunner = { repository: name, repositoryId: repoId, memberId,
    sharedAdmission };
  requireThat(isId(observed.repo.owner?.id), 'SHARED_EXECUTION_OWNER_INVALID');
  if (sharedAdmission) requireThat(sharedAdmission.ownerId === observed.repo.owner.id,
    'SHARED_EXECUTION_OWNER_INVALID');
  requireSharedBranch(policyRunner, observed.branch.protected,
    'SHARED_EXECUTION_BRANCH_UNPROTECTED');
  const [binding, registrations, oidc] = await Promise.all([
    observeAdoptionWorkflow(reader, root, sharedWorkflowPath, observed.head, workflow),
    reader.list(root + '/actions/runners', 'runners'),
    reader.get(root + '/actions/oidc/customization/sub'),
  ]);
  requireThat(oidc.use_default === true, 'SHARED_CUSTOM_OIDC_TEMPLATE_UNSUPPORTED');
  requireThat(typeof oidc.use_immutable_subject === 'boolean',
    'SHARED_OIDC_SUBJECT_FORMAT_UNVERIFIED');
  const pool = registrations.filter(value =>
    value.labels?.some(label => label.name === 'nibfin-shared'));
  const runners = ids.map((id, index) => {
    const expected = `nibfin-${repoId}-${memberId}-${index + 1}`;
    const runner = pool.find(value => value.id === id && value.name === expected);
    requireThat(runner?.os === 'Linux' && runner.status === 'offline' &&
      runner.busy === false &&
      runner.labels.some(label => label.name === `nibfin-user-${memberId}`),
    'SHARED_HOST_REGISTRATION_CHANGED');
    return { runnerId: id, runnerName: expected };
  });
  requireThat(pool.length === 2 && runners.length === 2 &&
    runners[0].runnerId !== runners[1].runnerId,
  'SHARED_HOST_REGISTRATION_CHANGED');
  const { repo, actor, head, branch } = observed;
  const branchPath = `${root}/branches/${encodeURIComponent(branch.name)}`;
  const latest = await reader.get(branchPath);
  requireThat(latest.commit?.sha === head,
    'SHARED_EXECUTION_BRANCH_CHANGED');
  requireSharedBranch(policyRunner, latest.protected,
    'SHARED_EXECUTION_BRANCH_CHANGED');
  const ref = `refs/heads/${branch.name}`;
  const identity = { repository: name, repositoryId: repoId };
  const runner = { ...identity, sharedAdmission, ...binding, ...runners[0], memberId,
    sourceCommit: head,
    member: { id: actor.id, login: actor.login, type: actor.type }, os: 'linux',
    jobName: 'shared-stage' };
  const [owner, repository] = name.split('/');
  const subjectRepo = oidc.use_immutable_subject ?
    `${owner}@${repo.owner.id}/${repository}@${repoId}` : name;
  const caller = { ...identity, ownerId: repo.owner.id, ref,
    subject: `repo:${subjectRepo}:ref:${ref}`,
    workflowRef: `${name}/${sharedWorkflowPath}@${ref}` };
  return { runner, caller, second: runners[1], observed };
}

async function publishInitialHost(host, directory) {
  const temp = join(directory, `.nibfin-host-${randomUUID()}`);
  const json = JSON.stringify(host) + '\n';
  requireThat(Buffer.byteLength(json) <= limit, 'HOST_FILE_TOO_LARGE');
  try {
    const file = await open(temp, 'wx', 0o644);
    try {
      await file.chmod(0o644);
      await file.writeFile(json);
      await file.sync();
    } finally { await file.close(); }
    await link(temp, hostFile);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await syncRecoveryDirectory(directory);
  }
  return inspectSharedHost();
}

export async function adoptSharedHost(name, id, memberId, actionCommit, ids, pinBytes) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'SHARED_HOST_ADOPTION_REQUIRES_ADMIN');
  requireThat([id, memberId, ...ids].every(isId) && isSha(actionCommit),
    'INVALID_SHARED_HOST_IDENTITY');
  const pin = JSON.parse(pinBytes);
  const source = await verifyInstalledSource(coreRoot, pin);
  return withManagedAdmission(() => withSharedAdoptionLock(async directory => {
    const path = join(directory, profileName);
    let retirement;
    try {
      await lstat(hostFile);
      retirement = await retiredReplacement({ repository: name, repositoryId: id,
        memberId, runners: ids.map(id => ({ id })) });
      const current = await boundedHostFile(hostFile, 262144);
      requireThat(current === retirement.binding.adoptions[0].bytes ||
        current === retirement.replacement?.bytes, 'RETIREMENT_ADOPTION_CHANGED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rootOwnedPath(path);
    const bytes = await boundedHostFile(path, limit);
    const { uid, runnerUid, secondUid, stateRoot, tokenFile, authFile, model, isolation,
      secondaryIsolation, globalInstructionsFile, mcp, managedEgressNetwork } =
      await controllerProfile(JSON.parse(bytes));
    const token = (await boundedHostFile(tokenFile, 16384)).trim();
    const reader = new GitHubReader(token);
    await verifyAdoptionAction(reader, actionCommit, pin);
    const shared = await boundedHostFile(join(coreRoot, sharedWorkflowPath), 65536);
    const profile = JSON.parse(bytes);
    let sharedAdmission;
    if (profile.sharedAdmission !== undefined) {
      requireThat(profile.sharedAdmission === managedSharedAdmission,
        'SHARED_ADMISSION_POLICY_INVALID');
      const repo = await reader.get(repoPath(name));
      sharedAdmission = { kind: profile.sharedAdmission, repository: name,
        repositoryId: id, memberId, ownerId: repo.owner?.id };
    }
    const pool = await observeExecutionPool(reader, name, id, memberId, ids,
      source, actionCommit, shared, sharedAdmission);
    const { runner, caller, second, observed } = pool;
    const host = { schemaVersion: 1, kind: 'single-host-linux-v1', uid, runnerUid,
      memberId, stateRoot, tokenFile, authFile, model, globalInstructionsFile, mcp,
      runnerId: runner.runnerId, installation: { directory: coreRoot, pin },
      repository: { isolation },
      sharedRunner: { runner, caller, repositories: [id],
        additionalRunner: { uid: secondUid, id: second.runnerId,
          name: second.runnerName, isolation: secondaryIsolation } } };
    host.providerBinding = createProviderBinding(host, profile.provider);
    if (managedEgressNetwork !== undefined) {
      const [primary, secondary] = await prepareSharedGateways(
        [isolation, secondaryIsolation], runner, second, managedEgressNetwork);
      host.repository.isolation = primary;
      host.sharedRunner.additionalRunner.isolation = secondary;
    }
    const workflow = await boundedHostFile(join(coreRoot, issueWorkflow), 65536);
    host.repository = peerConfiguration(host, name, id, source, actionCommit,
      observed, gitBlob(workflow)).repository;
    sharedHostRegistrations(host);
    sharedSlotIsolation(host, secondUid);
    requireThat(await boundedHostFile(path, limit) === bytes &&
      (await boundedHostFile(tokenFile, 16384)).trim() === token &&
      digest(await verifyInstalledSource(coreRoot, pin)) === digest(source),
    'SHARED_HOST_ADOPTION_CHANGED');
    if (managedEgressNetwork !== undefined) await installSharedRelay();
    if (retirement) {
      await releaseRetiredReplacement(retirement, host,
        () => writeRetirementFile(hostFile, host));
      return inspectSharedHost();
    }
    return publishInitialHost(host, directory);
  }));
}
