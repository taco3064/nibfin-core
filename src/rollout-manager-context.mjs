import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { digest, isSha, requireThat } from './identity.mjs';

export const managerRoot = '/usr/local/libexec/nibfin/core-rollout/manager';
export const managerPin = '/usr/local/libexec/nibfin/core-rollout/source-pin.json';
export const installationRoot = '/opt/nibfin/core';
const admitted = new WeakSet();

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
  await rootOwnedPath(managerPin);
  const pin = JSON.parse(await readFile(managerPin, 'utf8'));
  const source = await verifyOwnedSourcePackage(codeRoot, pin);
  const inspectInstallation = async expected => {
      // Transaction paths are data readback only. Executable code never moves.
      let plan = null;
      try {
        const path = '/etc/nibfin/rollout-plan.json';
        await rootOwnedPath(path);
        plan = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      requireThat(!plan || isSha(plan.pin?.commit), 'INVALID_ROLLOUT_PLAN');
      const hostPath = '/etc/nibfin/host.json';
      await rootOwnedPath(hostPath);
      const host = JSON.parse(await readFile(hostPath, 'utf8'));
      requireThat(host.installation?.directory === installationRoot,
        'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
      // Host adoption and actual package readback establish installed state.
      // The management package pin describes code, never a version ancestry gate.
      const valid = [host.installation.pin, ...(plan?.apply ?
        [plan.pin, plan.apply.oldPin] : [])].filter(Boolean);
      requireThat(valid.some(value => digest(value) === digest(expected)),
        'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
      const paths = [installationRoot];
      if (plan?.apply && digest(plan.apply.oldPin) === digest(expected))
        paths.push(`/opt/nibfin/core-before-${plan.pin.commit}`);
      if (plan?.apply && digest(plan.pin) === digest(expected))
        paths.push(`/opt/nibfin/core-staged-${plan.pin.commit}`);
      for (const path of paths) {
        try { await rootOwnedPath(path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const observed = JSON.parse(await readFile(join(path,
          'nibfin-manifest.json'), 'utf8'));
        if (observed.commit !== expected.commit) continue;
        const source = await verifyOwnedSourcePackage(path, expected);
        return { path, source };
      }
      requireThat(false, 'ROLLOUT_MANAGER_HOST_SOURCE_UNAVAILABLE');
    };
  const context = Object.freeze({ codeRoot, installationRoot, pin, source,
    installationPath: async expected => (await inspectInstallation(expected)).path,
    verifyInstallation: async expected => (await inspectInstallation(expected)).source });
  admitted.add(context);
  return context;
}
