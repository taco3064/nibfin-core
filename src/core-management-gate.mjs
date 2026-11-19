import { constants, fstatSync, readlinkSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { rootOwnedPath } from './host-paths.mjs';
import { withKernelGate } from './kernel-gate.mjs';

export const managementDirectory = '/etc/nibfin';

// FD 3 is internal process inheritance, never an authority or a public argument.
// Taking flock again on the same open description does not lock against itself.
export async function withCoreManagementGate(use, { shared = false } = {}) {
  await rootOwnedPath(managementDirectory);
  const expected = await stat(managementDirectory);
  let inherited = false;
  try {
    const actual = fstatSync(3);
    inherited = actual.isDirectory() && actual.uid === 0 &&
      (actual.mode & 0o022) === 0 && actual.dev === expected.dev &&
      actual.ino === expected.ino && readlinkSync('/proc/self/fd/3') ===
        managementDirectory;
  } catch (error) { if (error.code !== 'EBADF' && error.code !== 'ENOENT') throw error; }
  const handle = inherited ? { fd: 3 } : await open(managementDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await withKernelGate(handle, () => use(handle),
      { shared, busyCode: 'CORE_MANAGEMENT_OPERATION_PENDING' });
  } finally { if (!inherited) await handle.close(); }
}
