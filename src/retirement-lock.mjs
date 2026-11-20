import { mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostFile, boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { withRelayGate } from './relay-state.mjs';
import {
  withSharedAdoptionLock, retirementLockMarker,
} from './shared-peer-adoption.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';
import { drainPath, retirementPath } from './retirement-admission.mjs';
import { readRetirementFile } from './retirement-files.mjs';

export async function withReplacementAwareAdoptionLock(action) {
  const state = await readRetirementFile(retirementPath);
  if (state?.phase === 'retired' && (state.replacement?.phase !== 'released' ||
    await readRetirementFile(drainPath) !== null))
    return withRetirementLock(action);
  return withSharedAdoptionLock(action);
}

// A retained adoption/rollout guard is never stolen. Only a tagged retirement
// guard can recover, after acquiring the kernel lock held by every retirement.
// The state machine must still reconcile every uncertain effect from readback.
export async function withRetirementLock(action) {
  return withRetirementGate(async directory => {
    await recoverRetirementGuard(directory);
    return withSharedAdoptionLock(action, { retirement: true });
  });
}

// Reuse the retirement kernel boundary without publishing an operation marker.
// Package cleanup must not leave an adoption guard behind after interruption.
export async function withRetirementGate(action) {
  const directory = dirname(hostFile), root = join(directory, 'retirement');
  await rootOwnedPath(directory);
  await mkdir(root, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath(root);
  return withRelayGate(root, () => action(directory));
}

// Recovery seam shared by controlled guard tests and the fixed installed entry.
// Call only while holding that entry's retirement kernel gate.
export async function recoverRetirementGuard(directory, inspect = rootOwnedPath) {
  const lock = join(directory, 'rollout.lock');
  const stat = await lstat(lock).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat) {
    await inspect(lock);
    requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 &&
      await boundedHostFile(lock, 4096, true) === retirementLockMarker,
    'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED');
    await unlink(lock);
    await syncRecoveryDirectory(directory);
  }
}
