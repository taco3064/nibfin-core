import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAdoptedSource, adoptedRecoveryPaths } from './adopted-source-path.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { isInstallationPin } from './source-package.mjs';
import { digest, isId, requireThat } from './identity.mjs';

const executing = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

// Only maintained source-bearing fields are considered, never credentials or
// arbitrary user files. References protect source by actual identity, not the
// deployment-target suffix of a backup name.
export async function packageProtection(candidate, {
  live = '/opt/nibfin/core', config = '/etc/nibfin', read,
  match = async (path, pin) => {
    try { return { path, source: await verifyOwnedSourcePackage(path, pin) }; }
    catch (error) {
      if (['ENOENT', 'SOURCE_MANIFEST_MISMATCH'].includes(error.code)) return null;
      throw error;
    }
  },
  managementPins = async () => [],
} = {}) {
  if (candidate.path === live || candidate.path === executing) return 'EXECUTING_SOURCE';
  const observe = async (path, code) => {
    try { return await read(path); }
    catch { requireThat(false, code); }
  };
  const host = await observe(join(config, 'host.json'), 'PACKAGE_ADOPTION_UNAVAILABLE');
  requireThat(host?.installation?.directory === live &&
    isInstallationPin(host.installation.pin), 'PACKAGE_ADOPTION_UNAVAILABLE');
  const peers = host.wakePeerFiles ?? [];
  requireThat(Array.isArray(peers) && peers.every(path =>
    typeof path === 'string' &&
    /^host\.[A-Za-z0-9_-]+\.json$/.test(path.slice(config.length + 1)) &&
    path.startsWith(config + '/')), 'PACKAGE_ADOPTION_UNAVAILABLE');
  const adoptions = [host];
  for (const path of peers) {
    const peer = await observe(path, 'PACKAGE_ADOPTION_UNAVAILABLE');
    requireThat(peer?.installation?.directory === live &&
      isInstallationPin(peer.installation.pin), 'PACKAGE_ADOPTION_UNAVAILABLE');
    adoptions.push(peer);
  }
  const required = host.sharedRunner?.repositories ?? [];
  requireThat(Array.isArray(required) && required.every(id => isId(id) &&
    adoptions.some(adoption => adoption.repository?.approval?.repositoryId === id)),
  'PACKAGE_ADOPTION_UNAVAILABLE');
  const closure = await observe(join(config, 'rollout-admission.json'),
    'PACKAGE_APPLY_UNAVAILABLE');
  if (closure) {
    requireThat(closure.schemaVersion === 1 && isInstallationPin(closure.pin),
      'PACKAGE_APPLY_UNAVAILABLE');
    if (['staged', 'before'].some(kind =>
      candidate.name === `core-${kind}-${closure.pin.commit}`)) return 'ACTIVE_APPLY';
  }
  const plan = await observe(join(config, 'rollout-plan.json'),
    'PACKAGE_APPLY_UNAVAILABLE');
  if (plan) {
    requireThat(plan.schemaVersion === 2 && isInstallationPin(plan.pin),
      'PACKAGE_APPLY_UNAVAILABLE');
    if (candidate.name === `core-staged-${plan.pin.commit}` ||
      candidate.name === `core-before-${plan.pin.commit}` && plan.apply)
      return 'ACTIVE_APPLY';
  }
  for (const adoption of adoptions) {
    const pin = adoption.installation.pin;
    // Only this source could select this candidate. An unrelated stale peer
    // does not block it; a healthy live selection releases duplicate copies.
    if (pin.commit !== candidate.pin.commit) continue;
    let selected;
    try {
      selected = await selectAdoptedSource(pin, adoption,
        { live, match, readPlan: async () => plan });
    } catch { requireThat(false, 'PACKAGE_ADOPTION_UNAVAILABLE'); }
    if (selected.path === candidate.path) return 'ADOPTED_SOURCE';
  }
  for (const pin of await managementPins()) {
    requireThat(isInstallationPin(pin), 'PACKAGE_MANAGEMENT_REFERENCE_UNAVAILABLE');
    // Manager/bootstrap publication owns these pins. Resolve their actual
    // deployment recovery executable with the existing selection semantics.
    if (![host.installation.pin, plan?.pin, plan?.apply?.oldPin]
      .filter(Boolean).some(known => digest(known) === digest(pin))) continue;
    if (digest(pin) !== digest(candidate.pin) || !plan?.apply ||
      !isInstallationPin(plan.apply.oldPin) ||
      !adoptedRecoveryPaths(pin, plan, live).includes(candidate.path)) continue;
    const selected = await selectAdoptedSource(pin, host,
      { live, match, readPlan: async () => plan });
    if (selected.path === candidate.path) return 'MANAGEMENT_RECOVERY_SOURCE';
  }
  return null;
}
