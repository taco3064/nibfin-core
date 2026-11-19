import { requireNoRollout } from './rollout-admission.mjs';
import { isDeepStrictEqual } from 'node:util';
import { readRetirementFile } from './retirement-files.mjs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedHostFile, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { withRelayGate } from './relay-state.mjs';
import { publishPrivate } from './managed-credential-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export const retirementPath = '/etc/nibfin/managed-retirement.json';
export const drainPath = '/etc/nibfin/managed-pool-drain.json';

export async function requirePoolOpen(path = drainPath) {
  if (path === drainPath) await requireNoRollout();
  try {
    await lstat(path);
    requireThat(false, 'MANAGED_POOL_RETIRING');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function withPoolGate(host, action) {
  return withRelayGate(host.stateRoot, action,
    { uid: host.uid, name: 'pool-admission.lock' });
}

// The lease spans the entire admitted operation. Retirement takes the same
// kernel gate before publishing its root-owned marker, then waits for all leases.
// A crashed Controller leaves evidence; neither age nor PID absence removes it.
export async function poolAdmission(host, action, marker = drainPath) {
  const path = join(host.stateRoot, `pool-consumer-${randomUUID()}`);
  const leaseHost = { ...host, gid: (await lstat(host.stateRoot)).gid };
  const admitted = await withPoolGate(host, async () => {
    await requirePoolOpen(marker);
    if (marker === drainPath) await requireNoRetirement();
    await publishPrivate(path, JSON.stringify({ pid: process.pid }) + '\n', leaseHost);
    return { admitted: true };
  });
  if (!admitted.admitted) return admitted;
  try { return await action(); }
  finally {
    await unlink(path);
    await syncRecoveryDirectory(host.stateRoot);
  }
}

export async function withInstalledPoolAdmission(action) {
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  if (!host.sharedRunner) return action();
  // Do not let an old peer configuration select a different pool gate.
  await rootOwnedPath(dirname(hostFile));
  return poolAdmission(host, action);
}

export async function requirePoolConsumersSettled(host) {
  requireThat(!(await readdir(host.stateRoot)).some(name =>
    name.startsWith('pool-consumer-')), 'RETIREMENT_CONSUMER_PENDING');
}

export async function requireNoRetirement({ rollout = false } = {}) {
  if (!rollout) await requireNoRollout();
  try {
    await lstat(drainPath);
    requireThat(false, 'MANAGED_POOL_RETIRING');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = await readRetirementFile(retirementPath);
  if (!state) return;
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  const runner = host.sharedRunner?.runner;
  const second = host.sharedRunner?.additionalRunner;
  const pool = { repository: runner?.repository, repositoryId: runner?.repositoryId,
    memberId: host.memberId, runners: [
      { id: runner?.runnerId, name: runner?.runnerName },
      { id: second?.id, name: second?.name },
    ] };
  requireThat(state.phase === 'retired' && state.replacement?.phase === 'released' &&
    isDeepStrictEqual(pool, state.replacement.pool),
  'MANAGED_POOL_RETIREMENT_UNRESOLVED');
}
