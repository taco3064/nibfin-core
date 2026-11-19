import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { requireThat } from './identity.mjs';
import { isInstallationPin } from './source-package.mjs';

export const managerRoot = '/usr/local/libexec/nibfin/core-rollout/manager';
export const managerPin = '/usr/local/libexec/nibfin/core-rollout/source-pin.json';
export { installationRoot } from './adopted-source-path.mjs';
import { installationRoot, inspectAdoptedSource } from './adopted-source-path.mjs';
const admitted = new WeakSet();

export async function readManagerPin() {
  const info = await lstat(managerPin).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    requireThat(false, 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  });
  await rootOwnedPath(managerPin);
  requireThat(info.isFile() && info.nlink === 1, 'ROLLOUT_MANAGER_METADATA_UNKNOWN');
  let pin;
  try { pin = JSON.parse(await readFile(managerPin, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    requireThat(false, 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  }
  requireThat(isInstallationPin(pin), 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE');
  return pin;
}

export function requireManagerContext(context) {
  requireThat(admitted.has(context), 'ROLLOUT_MANAGER_NOT_ADMITTED');
  return context;
}

// This is an internal installed entry, never a caller-supplied path or flag.
// Code identity is independent of the package transaction's live filesystem.
export async function admitRolloutManager() {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    codeRoot === managerRoot, 'ROLLOUT_MANAGER_REQUIRES_INSTALLED_ADMIN');
  const pin = await readManagerPin();
  const source = await verifyOwnedSourcePackage(codeRoot, pin);
  const inspectInstallation = inspectAdoptedSource;
  const context = Object.freeze({ codeRoot, installationRoot, pin, source,
    installationPath: async expected => (await inspectInstallation(expected)).path,
    verifyInstallation: async expected => (await inspectInstallation(expected)).source });
  admitted.add(context);
  return context;
}
