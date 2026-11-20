import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { optionalStat, readRetirementFile } from './retirement-files.mjs';
import { inspectRetirementPackage, removeRetirementPackage }
  from './core-package-retirement-files.mjs';
import { retireCorePackages, retirementReason } from './core-package-retirement.mjs';
import { packageProtection } from './core-package-retirement-references.mjs';
import { requireNoResourceReferences } from './resource-references.mjs';
import { requireNoPackageServices } from './core-package-retirement-services.mjs';

const parent = '/opt/nibfin';
const deferred = code => [{ status: 'retained', code }];

async function ownedPackageFact(path) {
  const stat = await optionalStat(path);
  if (!stat) return null;
  await rootOwnedPath(path);
  const value = await readRetirementFile(path);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Object.assign(new Error('Package reference unavailable'),
      { code: 'PACKAGE_OBSERVATION_UNAVAILABLE' });
  return value;
}

async function sweep() {
  await rootOwnedPath(parent);
  return retireCorePackages({
    list: () => readdir(parent),
    inspect: name => inspectRetirementPackage(parent, name),
    protection: candidate => packageProtection(candidate, {
      read: ownedPackageFact,
      managementPins: async () => {
        // Historical .previous packages are self-contained recognition data,
        // not executable selections. Current publication/bootstrap pins may
        // select a deployment fallback only through the adopted-source rule.
        const base = '/usr/local/libexec/nibfin/core-rollout';
        const pins = [];
        for (const name of ['source-pin.json', 'bootstrap-source-pin.json']) {
          try {
            const pin = await ownedPackageFact(join(base, name));
            if (pin) pins.push(pin);
          } catch {
            throw Object.assign(new Error('Management reference unavailable'),
              { code: 'PACKAGE_MANAGEMENT_REFERENCE_UNAVAILABLE' });
          }
        }
        return pins;
      },
    }),
    unused: async candidate => {
      try { await requireNoResourceReferences(candidate.path); }
      catch (error) {
        if (['MANAGED_RESOURCE_IN_USE', 'RETIREMENT_RESOURCE_MOUNTED']
          .includes(error.code)) throw error;
        throw Object.assign(new Error('Use observation unavailable'),
          { code: 'PACKAGE_USE_OBSERVATION_UNAVAILABLE' });
      }
      try { await requireNoPackageServices(candidate.path); }
      catch (error) {
        if (error.code === 'PACKAGE_SERVICE_REFERENCE') throw error;
        throw Object.assign(new Error('Service observation unavailable'),
          { code: 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE' });
      }
    },
    remove: removeRetirementPackage,
  });
}

// The installed maintenance operation owns sweeping after release. Read
// current references again immediately before removing any verified bytes.
export async function retireInstalledCorePackages() {
  try { return await sweep(); }
  catch (error) { return deferred(retirementReason(error)); }
}
