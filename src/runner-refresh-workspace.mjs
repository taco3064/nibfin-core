import { lstat, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { digest, requireThat } from './identity.mjs';
import { resourceIdentity, optionalStat } from './retirement-files.mjs';
import { sharedTarget, verifySharedFile } from './shared-platform.mjs';
import { runnerEntryIdentity } from './runner-refresh-files.mjs';
import { cleanupRefreshEntries, removeEmptyRefreshDirectory, verifyRefreshWorkspace }
  from './runner-refresh-cleanup.mjs';
import { safeRelayCode } from './notification-relay.mjs';

export const refreshWorkspaceRoot = '/var/lib/nibfin/runners/.runtime-refresh';

export async function createRefreshWorkspace(parent = refreshWorkspaceRoot) {
  await rootOwnedPath(dirname(parent));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rootOwnedPath(parent);
  const path = await mkdtemp(join(parent, 'operation-'));
  return { path, identity: resourceIdentity(await lstat(path)) };
}

export async function inspectRefreshWorkspace(workspace, parent = refreshWorkspaceRoot) {
  validateRefreshWorkspace(workspace, parent);
  await verifyRefreshWorkspace(workspace);
}

export function validateRefreshWorkspace(workspace, parent = refreshWorkspaceRoot) {
  requireThat(workspace && dirname(workspace.path) === parent &&
    /^operation-[A-Za-z0-9]+$/.test(basename(workspace.path)),
  'RUNNER_REFRESH_WORKSPACE_CHANGED');
}

export function runnerRefreshMarker(state) {
  return structuredClone({ schemaVersion: 1, operation: 'official-runner-refresh',
    recovery: {
    schemaVersion: 1, phase: 'draining', binding: state.binding,
    selected: state.selected, running: state.running,
    workspace: state.workspace, slots: state.slots, pending: null,
    } });
}

export async function recoverRunnerRefresh(marker, binding, {
  parent = refreshWorkspaceRoot,
} = {}) {
  if (!marker || marker.operation !== 'official-runner-refresh') return null;
  const recovered = marker.recovery;
  requireThat(marker.schemaVersion === 1 && recovered?.schemaVersion === 1 &&
    digest(recovered.binding) === digest(binding), 'RUNNER_REFRESH_BINDING_CHANGED');
  validateRefreshWorkspace(recovered.workspace, parent);
  if (await optionalStat(recovered.workspace.path))
    await inspectRefreshWorkspace(recovered.workspace, parent);
  return { ...structuredClone(recovered), admission: structuredClone(marker) };
}

export function slotWorkspace(state, slot) {
  requireThat(slot === 1 || slot === 2, 'INVALID_RUNNER_REFRESH_SLOT');
  return join(state.workspace.path, `slot-${slot}`);
}

export function requireRefreshSlotIntent(state, slot) {
  const intent = state.slots[slot];
  requireThat(intent && (intent.staged === null ||
    dirname(intent.staged) === slotWorkspace(state, slot) &&
    /^staged-[A-Za-z0-9]+$/.test(basename(intent.staged))),
  'RUNNER_REFRESH_STAGING_CHANGED');
  return intent;
}

export async function cleanupRunnerRefresh(state) {
  const workspace = state.workspace.path;
  if (!await optionalStat(workspace)) return { status: 'removed', retained: [] };
  await inspectRefreshWorkspace(state.workspace);
  const retained = [], target = sharedTarget(state.selected.arch);
  const handled = new Set();
  for (const slot of [1, 2]) {
    const intent = requireRefreshSlotIntent(state, slot);
    const root = slotWorkspace(state, slot);
    handled.add(basename(root));
    for (const [path, field] of [[intent.staged, 'next'],
      [join(root, 'previous'), 'previous']]) {
      if (path === null) continue;
      const result = await cleanupRefreshEntries(path, intent.entries, field);
      retained.push(...result.retained);
      retained.push(...await removeEmptyRefreshDirectory(path));
    }
    retained.push(...await removeEmptyRefreshDirectory(root));
  }
  const archives = [];
  for (const name of await readdir(workspace)) {
    if (!/^package-download-[A-Za-z0-9]+\.tar\.gz$/.test(name) &&
        name !== 'runner.tar.gz') continue;
    const path = join(workspace, name);
    try {
      await verifySharedFile(path, state.selected.artifact.sha256, target, false);
      archives.push({ name, next: await runnerEntryIdentity(path) });
    } catch (error) { retained.push({ path, code: safeRelayCode(error) }); }
  }
  const result = await cleanupRefreshEntries(workspace, archives, 'next');
  // Entries outside the explicit archive inventory are handled above or retained.
  retained.push(...result.retained.filter(entry => !handled.has(basename(entry.path))));
  retained.push(...await removeEmptyRefreshDirectory(workspace));
  const observed = new Map();
  for (const entry of retained) if (!observed.has(entry.path))
    observed.set(entry.path, entry);
  const unique = [...observed.values()];
  return { status: unique.length ? 'pending' : 'removed', retained: unique };
}
