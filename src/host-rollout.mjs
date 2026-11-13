import {
  lstat, open, readdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { idleContainers } from './host-containers.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { digest, isSha, requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { verifyInstalledSource } from './source-package.mjs';

const coreRoot = '/opt/nibfin/core';
const planPath = '/etc/nibfin/rollout-plan.json';
const e2eHost = 'host.nibfin-e2e.json';
const repositories = [
  ['nibfin-core', 'host.json'],
  ['nibfin-act', 'host.nibfin-act.json'],
  ['gh-nibfin', 'host.gh-nibfin.json'],
];

async function readTrusted(path) {
  await rootOwnedPath(path);
  const stat = await lstat(path);
  requireThat(stat.isFile() && stat.size <= 262144, 'INVALID_ROLLOUT_CONFIGURATION');
  const bytes = await readFile(path, 'utf8');
  requireThat(Buffer.byteLength(bytes) <= 262144, 'ROLLOUT_CONFIGURATION_TOO_LARGE');
  return { bytes, value: JSON.parse(bytes) };
}

export function validateRolloutHost(repository, current, next, pin, source, action) {
  const path = `taco3064/${repository}`;
  requireThat(next.kind === current.kind && next.uid === current.uid &&
    next.runnerUid === current.runnerUid && next.runnerId === current.runnerId &&
    next.memberId === current.memberId && next.stateRoot === current.stateRoot &&
    next.tokenFile === current.tokenFile && next.authFile === current.authFile &&
    next.repository?.runner?.repository === path &&
    next.repository?.eventRunner?.repository === path &&
    next.repository.runner.runnerId === next.runnerId &&
    next.repository.eventRunner.runnerId === next.runnerId &&
    next.repository.runner.memberId === next.memberId &&
    next.repository.eventRunner.memberId === next.memberId &&
    next.installation?.directory === coreRoot &&
    digest(next.installation.pin) === digest(pin) &&
    digest(next.repository.approval.source) === digest(source) &&
    next.repository.runner.actionCommit === action &&
    next.repository.runner.actionCoreCommit === pin.commit &&
    next.repository.eventRunner.reusable?.commit === pin.commit &&
    next.repository.eventCaller?.reusable?.commit === pin.commit &&
    digest(next.sharedRunner ?? null) === digest(current.sharedRunner ?? null),
  'ROLLOUT_HOST_BINDING_MISMATCH');
}

export function validateE2eRollout(next, primary, source) {
  const config = next.repository;
  const { reusable, ...runner } = config?.eventRunner ?? {};
  const event = config?.eventRunner;
  const approval = config?.approval;
  const repository = 'taco3064/nibfin-e2e';
  const core = source.commit;
  requireThat(
    ['schemaVersion', 'kind', 'uid', 'memberId', 'stateRoot', 'tokenFile', 'authFile']
      .every(key => next[key] === primary[key]) &&
      digest(next.installation) === digest(primary.installation) &&
      next.runnerId === primary.sharedRunner?.runner?.runnerId &&
      approval?.kind === 'repository-admission-v1' &&
      approval.repository === repository && approval.memberId === primary.memberId &&
      approval.repositoryId === 1445256917 &&
      digest(approval.source) === digest(source) &&
      event?.repository === repository && event.repositoryId === approval.repositoryId &&
      event.runnerId === next.runnerId && event.memberId === next.memberId &&
      event.workflowPath === '.github/workflows/nibfin-issue.yml' &&
      reusable?.commit === core && next.repository.eventCaller?.eventName === 'issues' &&
      digest(config.runner) === digest(runner) &&
      digest(config.isolation) === digest(primary.repository.isolation) &&
      Object.keys(next.issues ?? {}).length === 0,
    'ROLLOUT_E2E_BINDING_MISMATCH',
  );
  return approval.repositoryId;
}

async function readOptionalHost(path) {
  try { return await readTrusted(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requireMissing(path, code) {
  try { await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  requireThat(false, code);
}

// Administrator-only. The plan and staged bindings are prepared out of band
// under /etc/nibfin. A public workflow or ordinary Runner cannot supply them.
export async function promoteHost() {
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'ROLLOUT_REQUIRES_HOST_ADMINISTRATOR');
  const lockPath = '/etc/nibfin/rollout.lock';
  await rootOwnedPath('/etc/nibfin');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    return await promoteLockedHost();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function promoteLockedHost() {
  const { value: plan } = await readTrusted(planPath);
  requireThat(isSha(plan.pin?.commit) && isSha(plan.actionCommit) &&
    plan.pin.repository === 'taco3064/nibfin-core', 'INVALID_ROLLOUT_PLAN');
  const staged = `/opt/nibfin/core-staged-${plan.pin.commit}`;
  await rootOwnedPath(coreRoot);
  await rootOwnedPath(staged);
  const source = await verifyInstalledSource(staged, plan.pin);
  const stagedConfig = '/etc/nibfin/rollout';
  const hosts = await Promise.all(repositories.map(async ([repository, name]) => {
    const path = join('/etc/nibfin', name);
    const current = await readTrusted(path);
    const next = await readTrusted(join(stagedConfig, name));
    validateRolloutHost(repository, current.value, next.value,
      plan.pin, source, plan.actionCommit);
    return { repository, name, path, current, next };
  }));
  const primary = hosts[0];
  const e2ePath = join('/etc/nibfin', e2eHost);
  const e2e = await readOptionalHost(join(stagedConfig, e2eHost));
  const currentE2e = await readOptionalHost(e2ePath);
  requireThat(e2e || !currentE2e, 'ROLLOUT_E2E_CONFIGURATION_MISSING');
  const targets = [...hosts];
  if (e2e) {
    const id = validateE2eRollout(e2e.value, primary.next.value, source);
    const { sharedRunner } = primary.next.value;
    sharedRunner.repositories = [...new Set([...sharedRunner.repositories, id])];
    primary.next.value.wakePeerFiles = [
      ...new Set([...primary.next.value.wakePeerFiles, e2ePath]),
    ];
    primary.next.bytes = JSON.stringify(primary.next.value);
    targets.push({ path: e2ePath, current: currentE2e, next: e2e });
  }
  const oldPin = primary.current.value.installation.pin;
  requireThat(hosts.every(host => digest(host.current.value.installation.pin) ===
    digest(oldPin)), 'ROLLOUT_EXISTING_HOSTS_DIVERGED');
  const agentProfiles = hosts.map(host => host.next.value.repository.isolation.agent);
  const networks = agentProfiles.map(agent => `${agent.socket}:${agent.network}`);
  const gateways = agentProfiles.map(agent => `${agent.socket}:${agent.gatewayId}`);
  const policies = agentProfiles.map(agent => agent.mcpPolicyDirectory).filter(Boolean);
  requireThat([networks, gateways, policies].every(list =>
    list.length === new Set(list).size), 'ROLLOUT_RUNNER_ISOLATION_SHARED');
  await verifyInstalledSource(coreRoot, oldPin);
  const backup = `/opt/nibfin/core-before-${plan.pin.commit}`;
  await requireMissing(backup, 'ROLLOUT_BACKUP_ALREADY_EXISTS');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };
  for (const host of hosts) {
    const status = await command('/usr/bin/systemctl',
      ['is-active', `${host.repository}-runner.service`],
      { env, allowedExitCodes: [0, 3, 4] });
    requireThat(status.stdout.toString().trim() === 'inactive', 'ROLLOUT_RUNNER_ACTIVE');
    const config = host.current.value;
    await idleContainers(config.repository.isolation);
  }
  for (const root of new Set(hosts.map(host => host.current.value.stateRoot))) {
    await requireMissing(join(root, 'stage.lock'), 'ROLLOUT_FENCE_PRESENT');
    for (const name of await readdir(root)) {
      if (/^issue-[1-9]\d*-[1-9]\d*$/.test(name))
        await requireMissing(join(root, name, 'stage.lock'), 'ROLLOUT_FENCE_PRESENT');
    }
  }
  const replace = async (path, bytes) => {
    const temp = `${path}.rollout-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { mode: 0o644, flag: 'wx' });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
  const changed = [];
  let stagedIsLive = false;
  await rename(coreRoot, backup);
  try {
    await rename(staged, coreRoot);
    stagedIsLive = true;
    for (const host of targets) {
      await replace(host.path, host.next.bytes);
      changed.push(host);
    }
    await verifyInstalledSource(coreRoot, plan.pin);
    for (const host of targets) {
      requireThat((await readTrusted(host.path)).bytes === host.next.bytes,
        'ROLLOUT_HOST_READBACK_MISMATCH');
    }
  } catch (error) {
    for (const host of changed.reverse()) {
      if (host.current) await replace(host.path, host.current.bytes);
      else await unlink(host.path);
    }
    if (stagedIsLive) await rename(coreRoot, staged);
    await rename(backup, coreRoot);
    throw error;
  }
  return { status: 'installed', source, actionCommit: plan.actionCommit,
    repositories: targets.map(host => host.next.value.repository.runner.repository),
    backup };
}
