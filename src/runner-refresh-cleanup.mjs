import { lstat, readdir, readFile, readlink, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { optionalStat } from './retirement-files.mjs';
import { requireThat } from './identity.mjs';
import { safeRelayCode } from './notification-relay.mjs';
import { runnerEntryIdentity } from './runner-refresh-files.mjs';
import { assertNoSlotMounts } from './retirement-observe.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const refers = (value, path) => value === path || value.startsWith(path + '/') ||
  value === path + ' (deleted)';

export async function requireNoRefreshReferences(path, { proc = '/proc',
  mounts = assertNoSlotMounts } = {}) {
  await mounts(path);
  for (const pid of await readdir(proc)) {
    if (!/^[1-9][0-9]*$/.test(pid)) continue;
    const root = join(proc, pid);
    try {
      for (const name of ['exe', 'cwd']) {
        const observed = await readlink(join(root, name));
        requireThat(!refers(observed, path), 'RUNNER_REFRESH_PREVIOUS_IN_USE');
      }
      const maps = await readFile(join(root, 'maps'), 'utf8');
      requireThat(!maps.split('\n').some(line => {
        const file = /^(?:\S+\s+){5}(.*)$/.exec(line)?.[1];
        return file && refers(file, path);
      }), 'RUNNER_REFRESH_PREVIOUS_IN_USE');
      for (const fd of await readdir(join(root, 'fd'))) {
        try {
          requireThat(!refers(await readlink(join(root, 'fd', fd)), path),
            'RUNNER_REFRESH_PREVIOUS_IN_USE');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      // A process that exited contributes no remaining reference. Failed access
      // to a live process is uncertainty and preserves the affected material.
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
}

const defaultPorts = { inspect: rootOwnedPath, references: requireNoRefreshReferences,
  remove: path => rm(path, { recursive: true }) };

export async function cleanupRefreshEntries(directory, entries, field,
  supplied = {}) {
  const ports = { ...defaultPorts, ...supplied };
  const result = { removed: [], retained: [] };
  if (!await optionalStat(directory)) return result;
  await ports.inspect(directory);
  const expected = new Map(entries.map(entry => [entry.name, entry[field]]));
  for (const name of await readdir(directory)) {
    const path = join(directory, name), identity = expected.get(name);
    try {
      requireThat(typeof identity === 'string', 'RUNNER_REFRESH_RESOURCE_UNKNOWN');
      requireThat(await runnerEntryIdentity(path) === identity,
        'RUNNER_REFRESH_RESOURCE_CHANGED');
      await ports.references(path);
      requireThat(await runnerEntryIdentity(path) === identity,
        'RUNNER_REFRESH_RESOURCE_CHANGED');
      try { await ports.remove(path); }
      catch (error) { if (await optionalStat(path)) throw error; }
      requireThat(!await optionalStat(path), 'RUNNER_REFRESH_DELETE_UNCONFIRMED');
      result.removed.push(path);
    } catch (error) { result.retained.push({ path, code: safeRelayCode(error) }); }
  }
  await syncRecoveryDirectory(directory);
  return result;
}

export async function removeEmptyRefreshDirectory(path) {
  if (!await optionalStat(path)) return [];
  await rootOwnedPath(path);
  const remaining = await readdir(path);
  if (remaining.length) return remaining.map(name => ({ path: join(path, name),
    code: 'RUNNER_REFRESH_RESOURCE_RETAINED' }));
  await requireNoRefreshReferences(path);
  try { await rmdir(path); }
  catch (error) { if (await optionalStat(path)) throw error; }
  return [];
}

export async function verifyRefreshWorkspace(workspace) {
  await rootOwnedPath(workspace.path);
  const stat = await lstat(workspace.path);
  requireThat(stat.isDirectory() && stat.dev === workspace.identity.dev &&
    stat.ino === workspace.identity.ino && (stat.mode & 0o777) === 0o700,
  'RUNNER_REFRESH_WORKSPACE_CHANGED');
}
