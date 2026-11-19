import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export async function maintenanceFile(path) {
  const info = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) return null;
  await rootOwnedPath(path);
  requireThat(info.isFile() && info.nlink === 1, 'CORE_MAINTENANCE_RESOURCE_UNKNOWN');
  return readFile(path);
}

// Known predecessor bytes come from complete verified source packages. Root
// ownership alone never turns a foreign installed program into an owned entry.
export async function publishMaintenanceFile(path, expected, predecessors, mode,
  validate = async () => {}) {
  await rootOwnedPath(dirname(path));
  const current = await maintenanceFile(path);
  requireThat(current === null || [expected, ...predecessors].some(bytes =>
    bytes.equals(current)), 'CORE_MAINTENANCE_RESOURCE_UNKNOWN');
  if (current?.equals(expected) && ((await lstat(path)).mode & 0o777) === mode) {
    await validate(path);
    return false;
  }
  const staged = join(dirname(path), `.core-maintenance-${randomUUID()}`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, mode);
  let failed = false;
  try {
    try {
      await handle.chown(0, 0);
      await handle.chmod(mode);
      await handle.writeFile(expected);
      await handle.sync();
    } catch (error) { failed = true; throw error; }
    finally {
      await handle.close().catch(error => { if (!failed) throw error; });
    }
    await validate(staged);
    const actual = await maintenanceFile(path);
    requireThat(actual === null ? current === null :
      current !== null && actual.equals(current),
      'CORE_MAINTENANCE_RESOURCE_CHANGED');
    await rename(staged, path);
    await syncRecoveryDirectory(dirname(path));
    requireThat((await maintenanceFile(path))?.equals(expected),
      'CORE_MAINTENANCE_RESOURCE_READBACK_REQUIRED');
    return true;
  } catch (error) { failed = true; throw error; }
  finally {
    await unlink(staged).catch(error => {
      if (error.code !== 'ENOENT' && !failed) throw error;
    });
  }
}
