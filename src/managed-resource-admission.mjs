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

// The installation parent survives package replacement and is readable by the
// Controller. Host configuration directories may grant search access only.
// Shared leases span admission; preparation takes the exclusive lease.
export async function withResourcePreparationLock(action, { preparing = false } = {}) {
  const directory = '/opt/nibfin';
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
