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
    next.repository.eventCaller?.reusable?.commit === pin.commit,
  'ROLLOUT_HOST_BINDING_MISMATCH');
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
  const oldPin = hosts[0].current.value.installation.pin;
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
    for (const host of hosts) {
      await replace(host.path, host.next.bytes);
      changed.push(host);
    }
    await verifyInstalledSource(coreRoot, plan.pin);
    for (const host of hosts) {
      requireThat((await readTrusted(host.path)).bytes === host.next.bytes,
        'ROLLOUT_HOST_READBACK_MISMATCH');
    }
  } catch (error) {
    for (const host of changed.reverse()) await replace(host.path, host.current.bytes);
    if (stagedIsLive) await rename(coreRoot, staged);
    await rename(backup, coreRoot);
    throw error;
  }
  return { status: 'installed', source, actionCommit: plan.actionCommit,
    repositories: repositories.map(([repository]) => `taco3064/${repository}`),
    backup };
}
