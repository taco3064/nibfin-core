import { lstat, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat } from './identity.mjs';

// Called after confirmed termination. Sources can be fetched again on retry.
// Keep the actual Writer workspace, outputs, reports and recovery records.
export async function discardRoleSources(io) {
  for (const path of [join(io, 'current-main'), join(io, 'input', 'upstream')]) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() &&
      await realpath(path) === path, 'UNSAFE_ROLE_SOURCE_CLEANUP');
    await rm(path, { recursive: true });
  }
}
