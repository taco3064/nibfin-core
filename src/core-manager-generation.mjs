import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { isInstallationPin } from './source-package.mjs';
import { requireThat } from './identity.mjs';

export const managerBase = '/usr/local/libexec/nibfin/core-rollout';
export const managerRoot = join(managerBase, 'manager');
export const managerPin = join(managerBase, 'source-pin.json');
export const managerSelectionPath = join(managerBase, 'current-manager.json');
export const managerGenerationName =
  /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function metadata(path) {
  await rootOwnedPath(path);
  const observed = await lstat(path);
  requireThat(observed.isFile() && observed.nlink === 1,
    'ROLLOUT_MANAGER_METADATA_UNKNOWN');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    requireThat(false, 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  }
}

export async function selectedManager() {
  let selected;
  try { selected = await metadata(managerSelectionPath); }
  catch (error) {
    if (error.code === 'ENOENT') return managerRoot;
    throw error;
  }
  requireThat(selected?.schemaVersion === 1 &&
    managerGenerationName.test(selected.generation), 'ROLLOUT_MANAGER_METADATA_UNKNOWN');
  return join(managerBase, selected.generation, 'package');
}

export function managerMetadataDirectory(codeRoot) {
  if (codeRoot === managerRoot) return managerBase;
  const directory = dirname(codeRoot);
  requireThat(dirname(directory) === managerBase &&
    managerGenerationName.test(directory.slice(managerBase.length + 1)) &&
    join(directory, 'package') === codeRoot, 'ROLLOUT_MANAGER_REQUIRES_INSTALLED_ADMIN');
  return directory;
}

export async function readManagerPin(codeRoot) {
  const selected = codeRoot ?? await selectedManager();
  const path = join(managerMetadataDirectory(selected), 'source-pin.json');
  let pin;
  try { pin = await metadata(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    requireThat(false, 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  }
  requireThat(isInstallationPin(pin), 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  return pin;
}
