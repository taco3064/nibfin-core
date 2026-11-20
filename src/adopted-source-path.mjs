import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, isSha, isDigest, requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';

export const installationRoot = '/opt/nibfin/core';

async function matchingPackage(path, expected) {
  try { await rootOwnedPath(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = join(path, 'nibfin-manifest.json');
  await rootOwnedPath(manifest);
  const observed = JSON.parse(await readFile(manifest, 'utf8'));
  if (observed.commit !== expected.commit) return null;
  return { path, source: await verifyOwnedSourcePackage(path, expected) };
}

// This is source data readback, not execution admission or a new context.
// A healthy adopted LIVE does not depend on an unrelated stale planning record.
export async function inspectAdoptedSource(expected) {
  const hostPath = '/etc/nibfin/host.json';
  await rootOwnedPath(hostPath);
  const host = JSON.parse(await readFile(hostPath, 'utf8'));
  return selectAdoptedSource(expected, host, {
    live: installationRoot, match: matchingPackage,
    readPlan: async () => {
      const path = '/etc/nibfin/rollout-plan.json';
      try { await rootOwnedPath(path); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      return JSON.parse(await readFile(path, 'utf8'));
    },
  });
}

// Shared executable selection, including healthy LIVE's independence from a
// stale plan. Retirement uses the same rule for each current retained pin.
export async function selectAdoptedSource(expected, host, { live, match, readPlan }) {
  requireThat(host.installation?.directory === live && expected &&
    host.installation.pin, 'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
  requireThat(expected.repository === 'taco3064/nibfin-core' &&
    isSha(expected.commit) && isDigest(expected.manifestHash),
  'INVALID_INSTALLATION_PIN');
  if (digest(expected) === digest(host.installation.pin)) {
    const selected = await match(live, expected);
    if (selected) return selected;
  }
  const plan = await readPlan();
  if (!plan) {
    requireThat(digest(expected) === digest(host.installation.pin),
      'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
    requireThat(false, 'ROLLOUT_MANAGER_HOST_SOURCE_UNAVAILABLE');
  }

  requireThat(plan?.schemaVersion === 2 && isSha(plan.pin?.commit) &&
    plan.apply && typeof plan.apply === 'object' && plan.apply.oldPin,
  'INVALID_ROLLOUT_PLAN');
  const valid = [host.installation.pin, plan.pin, plan.apply.oldPin];
  requireThat(valid.some(pin => digest(pin) === digest(expected)),
    'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
  const paths = adoptedRecoveryPaths(expected, plan, live);
  for (const path of paths) {
    const observed = await match(path, expected);
    if (observed) return observed;
  }
  requireThat(false, 'ROLLOUT_MANAGER_HOST_SOURCE_UNAVAILABLE');
}

export function adoptedRecoveryPaths(expected, plan, live = installationRoot) {
  const paths = [live];
  if (digest(plan.apply.oldPin) === digest(expected))
    paths.push(`${live}-before-${plan.pin.commit}`);
  if (digest(plan.pin) === digest(expected))
    paths.push(`${live}-staged-${plan.pin.commit}`);
  return paths;
}
