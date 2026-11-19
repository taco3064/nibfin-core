import { digest, requireThat } from './identity.mjs';
import {
  drainPath, retirementPath, requirePoolOpen,
} from './retirement-admission.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { verifyRunningSharedServices } from './shared-service-start.mjs';
import { verifyReplacementRunners } from './retirement-activate.mjs';
import {
  observeRetirementRegistrations, observeRetirementUnit, assertRetirementCgroups,
} from './retirement-observe.mjs';
import { repoPath } from './github-read.mjs';

// Legitimate retirement requires the exact closed binding and current native
// absence plus service/cgroup termination. A stale phase alone is insufficient.
export async function verifyLifecycleCleanupPool(host, pool, reader, read, ports = {}) {
  const stateFile = ports.stateFile ?? readRetirementFile;
  const registrations = ports.registrations ?? observeRetirementRegistrations;
  const unit = ports.unit ?? observeRetirementUnit;
  const cgroups = ports.cgroups ?? assertRetirementCgroups;
  requireThat(pool.memberId === host.memberId, 'NOTIFICATION_POOL_CHANGED');
  const { schemaVersion: _schema, adoptedRepositoryIds: _ids, ...identity } = pool;
  const state = await stateFile(retirementPath);
  if (state?.phase === 'retired' && state.pending === null && !state.replacement) {
    const marker = await stateFile(drainPath);
    requireThat(digest(marker) === digest({ schemaVersion: 1,
      retirementId: state.id, pool: state.binding.pool }) &&
      digest(identity) === digest(state.binding.pool),
    'NOTIFICATION_RETIREMENT_UNVERIFIED');
    for (const snapshot of state.binding.adoptions)
      requireThat(digest(await read(snapshot.path)) ===
        digest(JSON.parse(snapshot.bytes)),
        'HOST_ADOPTION_CHANGED');
    requireThat((await registrations(reader, pool))
      .every(value => value === 'absent'), 'NOTIFICATION_RETIREMENT_UNVERIFIED');
    for (const slot of [1, 2]) await unit(slot);
    await cgroups();
    requireThat(pool.adoptedRepositoryIds.length === state.binding.repositories.length &&
      state.binding.repositories.every(item =>
        pool.adoptedRepositoryIds.includes(item.repositoryId)),
    'NOTIFICATION_CONSUMERS_UNKNOWN');
    return state.binding.repositories.map(item => ({ ...item, route: 'retired' }));
  }
  await (ports.poolOpen ?? requirePoolOpen)();
  if (state) requireThat(state.phase === 'retired' &&
    state.replacement?.phase === 'released' &&
    digest(state.replacement.pool) === digest(identity),
  'NOTIFICATION_REPLACEMENT_UNVERIFIED');
  await (ports.runningServices ?? verifyRunningSharedServices)();
  const runners = await reader.list(
    repoPath(pool.repository) + '/actions/runners', 'runners');
  verifyReplacementRunners(pool, state?.binding.pool ?? { runners: [] }, runners);
  return null;
}
