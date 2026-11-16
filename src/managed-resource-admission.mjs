import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { rootOwnedPath } from './host-paths.mjs';
import { withKernelGate } from './kernel-gate.mjs';
import { requireThat } from './identity.mjs';

export const resourcePreparationGate = '/etc/nibfin/resource-preparation.pending';

export async function requireResourcesSettled(observe = lstat) {
  let present = true;
  try { await observe(resourcePreparationGate); }
  catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
  requireThat(!present, 'RESOURCE_PREPARATION_RECONCILIATION_REQUIRED');
}

// Use the existing root-owned directory as a stable cross-UID lock inode.
// Readers need no writable host files. Shared leases span the whole admission;
// preparation takes the exclusive lease before publishing intent or mutating.
export async function withResourcePreparationLock(action, { preparing = false } = {}) {
  const directory = '/etc/nibfin';
  await rootOwnedPath(directory);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try {
    return await resourcePreparationLease(handle, action, { preparing });
  } finally { await handle.close(); }
}

// Separated from fixed-path admission so native lock interleavings can be tested
// with disposable directory descriptors, without privileged host mutation.
export function resourcePreparationLease(handle, action, {
  preparing = false, observe = lstat,
} = {}) {
  return withKernelGate(handle, async () => {
    if (!preparing) await requireResourcesSettled(observe);
    return action();
  }, { shared: !preparing, busyCode: 'RESOURCE_PREPARATION_PENDING' });
}
