import { completeInstalledLifecycle } from './installed-lifecycle.mjs';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { inspectNotificationRelay } from './relay-service.mjs';
import { inspectSharedHost } from './shared-host-inspect.mjs';
import { adoptionReader } from './shared-peer-adoption.mjs';
import { observeLifecycleConsumers, verifyLifecycleActivation }
  from './lifecycle-route.mjs';
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
    const snapshots = new Map([[hostFile, bytes]]);
    const routes = await observeLifecycleConsumers(reader, host, source, async path => {
      await rootOwnedPath(path);
      const observed = await boundedHostFile(path, 262144);
      snapshots.set(path, observed);
      return JSON.parse(observed);
    });
    requireThat(routes.every(route => targets.some(target =>
      target.repositoryId === route.repositoryId &&
      target.repository === route.repository)), 'RETIREMENT_REPOSITORY_CHANGED');
    await verifyLifecycleActivation(routes, inspectNotificationRelay);
    await verifyRunningSharedServices();
    const registrations = await reader.list(
      repoPath(pool.repository) + '/actions/runners', 'runners');
    verifyReplacementRunners(pool, state.binding.pool, registrations);
    for (const [path, observed] of snapshots) {
      await rootOwnedPath(path);
      requireThat(await boundedHostFile(path, 262144) === observed,
        'RETIREMENT_ADOPTION_CHANGED');
    }
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
