import { rolloutPeerTargets } from './rollout-peers.mjs';
import { prepareRolloutRelay, validateRolloutRelay } from './rollout-relay.mjs';
import { constants } from 'node:fs';
import { withKernelGate } from './kernel-gate.mjs';
import { requireRolloutClosure } from './rollout-admission.mjs';
import { resumeHostApply } from './rollout-apply.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { requirePromotionSettlement } from './rollout-pool.mjs';
import { requireNoRetirement } from './retirement-admission.mjs';
import { validateProviderUpdate, compareProviderViews } from './provider-binding.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { withManagerAdmission } from './rollout-manager-admission.mjs';
import {
  lstat, open, readdir, readFile, unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { idleContainers } from './host-containers.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { digest, isSha, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { sharedSlotIsolation } from './shared-runner.mjs';

const coreRoot = '/opt/nibfin/core';
const planPath = '/etc/nibfin/rollout-plan.json';
const e2eHost = 'host.nibfin-e2e.json';
const repositories = [
  ['nibfin-core', 'host.json'],
  ['nibfin-act', 'host.nibfin-act.json'],
  ['gh-nibfin', 'host.gh-nibfin.json'],
];

async function readTrusted(path, limit = 262144) {
  await rootOwnedPath(path);
  const stat = await lstat(path);
  requireThat(stat.isFile() && stat.size <= limit, 'INVALID_ROLLOUT_CONFIGURATION');
  const bytes = await readFile(path, 'utf8');
  requireThat(Buffer.byteLength(bytes) <= limit, 'ROLLOUT_CONFIGURATION_TOO_LARGE');
  return { bytes, value: JSON.parse(bytes) };
}

export function validateRolloutHost(repository, current, next, pin, source, action,
  primary) {
  if (primary) {
    compareProviderViews(primary.current, current);
    compareProviderViews(primary.next, next);
  } else {
    validateProviderUpdate(current, next);
  }
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
    digest(next.sharedRunner ?? null) === digest(current.sharedRunner ?? null) &&
    digest(next.repository.isolation) === digest(current.repository.isolation),
  'ROLLOUT_HOST_BINDING_MISMATCH');
}

// Validate the installed pool before its enrolled views. Peers do not own a
// model/authentication profile or a new original installation identity.
export function validateRolloutHosts(hosts, pin, source, action) {
  const primary = hosts[0];
  validateRolloutHost(primary.repository, primary.current, primary.next,
    pin, source, action);
  for (const host of hosts.slice(1)) {
    const enrolled = primary.current.sharedRunner?.repositories
      ?.includes(host.current.repository?.approval?.repositoryId);
    validateRolloutHost(host.repository, host.current, host.next, pin, source,
      action, enrolled ? primary : undefined);
  }
}

export function validateE2eRollout(next, primary, source) {
  compareProviderViews(primary, next);
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

export function registerE2ePeer(host, path, repositoryId) {
  host.wakePeerFiles = [...new Set([...(host.wakePeerFiles ?? []), path])];
  if (host.sharedRunner) {
    const { repositories } = host.sharedRunner;
    host.sharedRunner.repositories = [...new Set([...repositories, repositoryId])];
  }
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
export async function promoteHost(context) {
  if (context !== undefined) requireManagerContext(context);
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'ROLLOUT_REQUIRES_HOST_ADMINISTRATOR');
  const lockPath = '/etc/nibfin/rollout.lock';
  await rootOwnedPath('/etc/nibfin');
  const gate = await open('/etc/nibfin/rollout',
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await withKernelGate(gate, async () => {
      // Only our own tagged lock can be recovered under this kernel gate.
      const marker = '"host-rollout-v2"\n';
      try {
        const existing = await readTrusted(lockPath);
        requireThat(existing.bytes === marker, 'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const file = await open(lockPath, 'wx', 0o600);
        try { await file.writeFile(marker); await file.sync(); }
        finally { await file.close(); }
      }
      try {
        const action = scope => promoteLockedHost(scope);
        return context ? await withManagerAdmission(context, action) :
          await withManagedAdmission(action);
      }
      finally { await unlink(lockPath); }
    });
  } finally { await gate.close(); }
}

async function promoteLockedHost(credentialScope) {
  await requireNoRetirement({ rollout: true });
  const { value: plan } = await readTrusted(planPath, 4 * 1024 * 1024);
  requireThat(isSha(plan.pin?.commit) && isSha(plan.actionCommit) &&
    plan.pin.repository === 'taco3064/nibfin-core', 'INVALID_ROLLOUT_PLAN');
  await requireRolloutClosure(plan);
  await requirePromotionSettlement(plan, credentialScope);
  if (plan.apply) {
    validateApplyIntent(plan);
    return resumeHostApply(plan);
  }
  const staged = `/opt/nibfin/core-staged-${plan.pin.commit}`;
  await rootOwnedPath(coreRoot);
  await rootOwnedPath(staged);
  const source = await verifyInstalledSource(staged, plan.pin);
  const stagedConfig = '/etc/nibfin/rollout';
  const hosts = await Promise.all(repositories.map(async ([repository, name]) => {
    const path = join('/etc/nibfin', name);
    const current = await readTrusted(path);
    const next = await readTrusted(join(stagedConfig, name));
    return { repository, name, path, current, next };
  }));
  validateRolloutHosts(hosts.map(host => ({ repository: host.repository,
    current: host.current.value, next: host.next.value })),
  plan.pin, source, plan.actionCommit);
  const primary = hosts[0];
  const e2ePath = join('/etc/nibfin', e2eHost);
  const e2e = await readOptionalHost(join(stagedConfig, e2eHost));
  const currentE2e = await readOptionalHost(e2ePath);
  requireThat(e2e || !currentE2e, 'ROLLOUT_E2E_CONFIGURATION_MISSING');
  const targets = [...hosts];
  if (e2e) {
    const id = validateE2eRollout(e2e.value, primary.next.value, source);
    for (const { next } of hosts) {
      registerE2ePeer(next.value, e2ePath, id);
      next.bytes = JSON.stringify(next.value);
    }
    targets.push({ path: e2ePath, current: currentE2e, next: e2e });
  }
  const oldPin = primary.current.value.installation.pin;
  requireThat(hosts.every(host => digest(host.current.value.installation.pin) ===
    digest(oldPin)), 'ROLLOUT_EXISTING_HOSTS_DIVERGED');
  const secondaryIsolation = validateRolloutIsolation(hosts.map(host => ({
    current: host.current.value, next: host.next.value,
  })));
  await verifyInstalledSource(coreRoot, oldPin);
  const backup = `/opt/nibfin/core-before-${plan.pin.commit}`;
  await requireMissing(backup, 'ROLLOUT_BACKUP_ALREADY_EXISTS');
  for (const host of hosts) await idleContainers(host.current.value.repository.isolation);
  if (secondaryIsolation) await idleContainers(secondaryIsolation);
  for (const root of new Set(hosts.map(host => host.current.value.stateRoot))) {
    await requireMissing(join(root, 'stage.lock'), 'ROLLOUT_FENCE_PRESENT');
    for (const name of await readdir(root)) {
      if (/^issue-[1-9]\d*-[1-9]\d*$/.test(name))
        await requireMissing(join(root, name, 'stage.lock'), 'ROLLOUT_FENCE_PRESENT');
    }
  }
  const apply = { oldPin, source, completed: false, targets: targets.map(host => ({
    path: host.path, current: host.current?.bytes ?? null,
    next: JSON.stringify(host.next.value) + '\n',
  })) };
  apply.targets.push(...await rolloutPeerTargets(plan.binding, apply.targets,
    validateRolloutHost, plan.pin, source, plan.actionCommit));
  apply.resources = await prepareRolloutRelay(apply.targets);
  const applying = { ...plan, apply, phase: 'applying',
    pending: 'ROLLOUT_APPLY_REQUIRED' };
  validateApplyIntent(applying);
  await writeRetirementFile(planPath, applying);
  return resumeHostApply(applying);
}

function validateApplyIntent(plan) {
  validateRolloutRelay(plan.apply);
  const targets = plan.apply?.targets;
  const names = [...repositories.map(([, name]) => name), e2eHost];
  requireThat(targets?.length === plan.binding.adoptions.length && names.every(name =>
    targets.some(target => target.path === join('/etc/nibfin', name))),
  'ROLLOUT_APPLY_INTENT_INVALID');
  requireThat(targets.every(target => plan.binding.adoptions.some(adoption =>
    adoption.path === target.path && adoption.bytes === target.current)),
  'ROLLOUT_ADOPTION_CHANGED');
  const hosts = repositories.map(([repository, name]) => {
    const target = targets.find(item => item.path === join('/etc/nibfin', name));
    return { repository, current: JSON.parse(target.current),
      next: JSON.parse(target.next) };
  });
  validateRolloutHosts(hosts, plan.pin, plan.apply.source, plan.actionCommit);
  for (const target of targets) {
    if (names.some(name => target.path === join('/etc/nibfin', name))) continue;
    const current = JSON.parse(target.current), next = JSON.parse(target.next);
    validateRolloutHost(current.repository.approval.repository.split('/')[1],
      current, next, plan.pin, plan.apply.source, plan.actionCommit);
  }
  requireThat(hosts.every(host => digest(host.current.installation.pin) ===
    digest(plan.apply.oldPin)), 'ROLLOUT_EXISTING_HOSTS_DIVERGED');
  const e2e = targets.find(item => item.path === join('/etc/nibfin', e2eHost));
  validateE2eRollout(JSON.parse(e2e.next), hosts[0].next, plan.apply.source);
}

export function validateRolloutIsolation(hosts) {
  requireThat(hosts.every(host => digest(host.current.repository.isolation) ===
    digest(host.next.repository.isolation)), 'ROLLOUT_RUNNER_ISOLATION_CHANGED');
  const primary = hosts[0].current;
  const second = primary.sharedRunner?.additionalRunner;
  requireThat(second?.isolation, 'ROLLOUT_SHARED_SLOTS_REQUIRED');
  const slots = [primary.runnerUid, second.uid]
    .map(uid => sharedSlotIsolation(primary, uid));
  const agents = slots.map(slot => slot.agent);
  for (const key of ['network', 'gatewayId', 'mcpPolicyDirectory']) {
    const values = agents.map(agent => agent[key] && `${agent.socket}:${agent[key]}`)
      .filter(Boolean);
    requireThat(new Set(values).size === values.length,
      'ROLLOUT_RUNNER_ISOLATION_SHARED');
  }
  return slots[1];
}
