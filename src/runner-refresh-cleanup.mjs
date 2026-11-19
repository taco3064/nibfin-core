import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { optionalStat } from './retirement-files.mjs';
import { requireThat } from './identity.mjs';
import { safeRelayCode } from './notification-relay.mjs';
import { runnerEntryIdentity } from './runner-refresh-files.mjs';
import { requireNoResourceReferences } from './resource-references.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export function requireNoRefreshReferences(path, supplied = {}) {
  return requireNoResourceReferences(path,
    { ...supplied, code: 'RUNNER_REFRESH_PREVIOUS_IN_USE' });
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
