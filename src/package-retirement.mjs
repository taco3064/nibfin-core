import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withCoreManagementGate } from './core-management-gate.mjs';
import { withResourcePreparationLock, requireResourcesSettled }
  from './managed-resource-admission.mjs';
import { withRetirementGate } from './retirement-lock.mjs';
import { optionalStat } from './retirement-files.mjs';
import { withPoolGate } from './retirement-admission.mjs';
import { loadAdoptedHost } from './adopted-host.mjs';
import { requireThat } from './identity.mjs';
import { packageName, classifyPackage, packageIdentity, removePackage }
  from './package-candidates.mjs';
import { observePackageBindings, installedPackageParent } from './package-bindings.mjs';
import { observePackageUse } from './package-use.mjs';
import { observePackageServices } from './package-services.mjs';

// One policy for explicit completion and the coordinator. Controlled ports do not
// alter the installed public command's identity, path or privilege requirements.
export async function retirePackages(ports) {
  const result = { retired: [], retained: [] };
  for (const path of await ports.discover()) {
    try {
      const candidate = await ports.classify(path);
      const inspect = async () => {
        requireThat(await ports.identity(path) === candidate.identity,
          'PACKAGE_IDENTITY_CHANGED');
        const current = await ports.classify(path);
        requireThat(current.manifest === candidate.manifest, 'PACKAGE_METADATA_CHANGED');
        const reason = (await ports.bindings())(current);
        requireThat(!reason, reason ?? 'PACKAGE_BINDING_UNKNOWN');
        const use = await ports.use(path);
        requireThat(!use.used, use.reason ?? 'PACKAGE_USE_UNKNOWN');
      };
      await inspect();
      await ports.remove(candidate, inspect);
      requireThat(await ports.identity(path) === null, 'PACKAGE_REMOVAL_UNCONFIRMED');
      result.retired.push(path);
    } catch (error) {
      // A lost response after completed deletion is reconciled, never replayed.
      if (await ports.identity(path).catch(() => 'unknown') === null)
        result.retired.push(path);
      else result.retained.push({ path, reason: packageRetirementCode(error) });
    }
  }
  return result;
}

export function packageRetirementCode(error) {
  return /^[A-Z][A-Z_]+$/.test(error?.code ?? '') ? error.code :
    'PACKAGE_OBSERVATION_OR_REMOVAL_UNCERTAIN';
}

export async function retireInstalledPackages() {
  try {
    // Reuse validated inherited directory descriptors from the fixed bridge.
    const result = await withCoreManagementGate(() =>
      withResourcePreparationLock(async () => {
        await requireResourcesSettled();
        return withRetirementGate(retireAdoptedPackages);
      }, { preparing: true }));
    return result.status === 'pending' ?
      { retired: [], retained: [], deferred: result.code } : result;
  } catch (error) {
    return { retired: [], retained: [], deferred: packageRetirementCode(error) };
  }
}

async function retireAdoptedPackages() {
  requireThat(!await optionalStat('/etc/nibfin/rollout.lock'),
    'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED');
  const context = await loadAdoptedHost({ authenticate: false });
  const run = async () => {
    // The exclusive resource lease excludes executing managed consumers. Pool
    // admission remains held through removal. Old consumer receipts alone do
    // not select source; actual process use and recovery bindings decide it.
    const parent = installedPackageParent(context);
    return retirePackages({
      discover: async () => (await readdir(parent))
        .filter(name => packageName.test(name)).map(name => join(parent, name)),
      classify: path => classifyPackage(path, parent),
      identity: packageIdentity,
      bindings: () => observePackageBindings(context),
      use: async path => {
        const services = await observePackageServices(path);
        return services.used ? services : observePackageUse(path);
      },
      remove: removePackage,
    });
  };
  return context.host.sharedRunner ? withPoolGate(context.host, run) : run();
}
