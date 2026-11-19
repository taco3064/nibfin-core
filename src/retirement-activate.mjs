import { completeInstalledLifecycle } from './installed-lifecycle.mjs';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { inspectSharedHost } from './shared-host-inspect.mjs';
import { sharedRepository } from './shared-runner.mjs';
import {
  adoptionReader, observePeer, verifyAdoptionAction,
} from './shared-peer-adoption.mjs';
import { verifyRunningSharedServices } from './shared-service-start.mjs';
import { retirementPath } from './retirement-admission.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { withRetirementLock } from './retirement-lock.mjs';
import { releaseRetiredReplacement } from './retirement-rebind.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';

export function verifyReplacementRunners(pool, old, registrations) {
  const shared = registrations.filter(runner =>
    runner.labels?.some(label => label.name === 'nibfin-shared'));
  requireThat(shared.length === 2 && !registrations.some(runner =>
    old.runners.some(previous => previous.id === runner.id)) &&
    pool.runners.every(expected => shared.some(runner =>
      runner.id === expected.id && runner.name === expected.name &&
      runner.os === 'Linux' && runner.status === 'online' && runner.busy === false &&
      runner.labels.some(label => label.name === `nibfin-user-${pool.memberId}`))),
  'RETIREMENT_REPLACEMENT_RUNNERS_UNVERIFIED');
}

async function verifyRepository(reader, host, target, source) {
  const adopted = await sharedRepository(host, target.repositoryId, async path => {
    await rootOwnedPath(path);
    return JSON.parse(await boundedHostFile(path, 262144));
  });
  const { approval, runner, eventRunner } = adopted.repository;
  requireThat(approval.repository === target.repository &&
    approval.memberId === host.memberId && runner.runnerId === host.runnerId &&
    runner.runnerName === host.sharedRunner.runner.runnerName &&
    eventRunner.runnerId === runner.runnerId &&
    eventRunner.runnerName === runner.runnerName,
  'RETIREMENT_REPOSITORY_CHANGED');
  await verifyAdoptionAction(reader, runner.actionCommit, host.installation.pin);
  const observed = await observePeer(reader, target.repository,
    target.repositoryId, host.memberId, source, runner.actionCommit);
  requireThat([[runner, observed.action], [eventRunner, observed.issue]].every(
    ([recorded, current]) => ['workflowId', 'workflowPath', 'workflowBlob'].every(
      field => recorded[field] === current[field])), 'RETIREMENT_WAKE_BINDING_CHANGED');
}

export async function activateSharedReplacement() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'RETIREMENT_REQUIRES_LOCAL_ADMIN');
  return activateThenContinue(
    () => withManagedAdmission(() => withRetirementLock(verifyAndReleaseReplacement)),
    completeInstalledLifecycle);
}

async function verifyAndReleaseReplacement() {
  await rootOwnedPath(hostFile);
  const bytes = await boundedHostFile(hostFile, 262144);
  const host = JSON.parse(bytes);
  const state = await readRetirementFile(retirementPath);
  const pool = await inspectSharedHost();
  await releaseRetiredReplacement(state, host, async () => {
    const targets = state.binding.repositories;
    requireThat(pool.adoptedRepositoryIds.length === targets.length &&
      targets.every(target => pool.adoptedRepositoryIds.includes(target.repositoryId)),
    'RETIREMENT_REPOSITORIES_UNVERIFIED');
    const source = await verifyInstalledSource(coreRoot, host.installation.pin);
    const reader = await adoptionReader(host);
    for (const target of targets) await verifyRepository(reader, host, target, source);
    await verifyRunningSharedServices();
    const registrations = await reader.list(
      repoPath(pool.repository) + '/actions/runners', 'runners');
    verifyReplacementRunners(pool, state.binding.pool, registrations);
    requireThat(await boundedHostFile(hostFile, 262144) === bytes,
      'RETIREMENT_ADOPTION_CHANGED');
  });
  return { status: 'active', retirementId: state.id, ...pool };
}

// The mutation callback must finish (and release its lock) before continuation.
export async function activateThenContinue(activate, resume) {
  const active = await activate();
  if (active.status !== 'active') return active;
  let continuation;
  try { continuation = await resume(); }
  catch { continuation = { status: 'pending', results: [] }; }
  return { ...active, continuation };
}
