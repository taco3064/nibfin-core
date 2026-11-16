import { open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';
export { resourceIdentity } from './managed-credential-files.mjs';

export async function readRetirementFile(path) {
  try {
    await rootOwnedPath(path);
    return JSON.parse(await boundedHostFile(path, 4 * 1024 * 1024));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeRetirementFile(path, value) {
  await rootOwnedPath(dirname(path));
  const temp = join(dirname(path), `.retirement-${randomUUID()}`);
  const bytes = JSON.stringify(value) + '\n';
  requireThat(Buffer.byteLength(bytes) <= 4 * 1024 * 1024,
    'RETIREMENT_STATE_TOO_LARGE');
  const file = await open(temp, 'wx', 0o644);
  try {
    try {
      await file.chmod(0o644);
      await file.writeFile(bytes);
      await file.sync();
    }
    finally { await file.close(); }
    await rename(temp, path);
    await syncRecoveryDirectory(dirname(path));
    requireThat(await boundedHostFile(path, 4 * 1024 * 1024) === bytes,
      'RETIREMENT_STATE_READBACK_REQUIRED');
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

