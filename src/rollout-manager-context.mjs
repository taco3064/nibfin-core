import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { requireThat } from './identity.mjs';
import { managerMetadataDirectory, readManagerPin } from './core-manager-generation.mjs';

export { managerRoot, managerPin, readManagerPin } from './core-manager-generation.mjs';
export { installationRoot } from './adopted-source-path.mjs';
import { installationRoot, inspectAdoptedSource } from './adopted-source-path.mjs';
const admitted = new WeakSet();

export function requireManagerContext(context) {
  requireThat(admitted.has(context), 'ROLLOUT_MANAGER_NOT_ADMITTED');
  return context;
}

// This is an internal installed entry, never a caller-supplied path or flag.
// Code identity is independent of the package transaction's live filesystem.
export async function admitRolloutManager() {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'ROLLOUT_MANAGER_REQUIRES_INSTALLED_ADMIN');
  managerMetadataDirectory(codeRoot);
  const pin = await readManagerPin(codeRoot);
  const source = await verifyOwnedSourcePackage(codeRoot, pin);
  const inspectInstallation = inspectAdoptedSource;
  const context = Object.freeze({ codeRoot, installationRoot, pin, source,
    installationPath: async expected => (await inspectInstallation(expected)).path,
    verifyInstallation: async expected => (await inspectInstallation(expected)).source });
  admitted.add(context);
  return context;
}
