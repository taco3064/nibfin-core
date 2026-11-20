import { lstat, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { managerRoot } from './rollout-manager-context.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';
import { assertNoSlotMounts } from './retirement-observe.mjs';
import { requireNoResourceReferences } from './resource-references.mjs';
import { managerGenerationName, readManagerPin, selectedManager }
  from './core-manager-generation.mjs';

const base = dirname(managerRoot);
const recoveryName = /^\.previous-[A-Za-z0-9]+$/;

async function readRecoveryPair(directory) {
  const name = directory.slice(base.length + 1);
  const generation = managerGenerationName.test(name);
  requireThat(dirname(directory) === base && (recoveryName.test(name) || generation),
    'CORE_MANAGER_RECOVERY_UNKNOWN');
  await rootOwnedPath(directory);
  const names = await readdir(directory);
  requireThat(names.length === (generation ? 3 : 2) && names.includes('package') &&
    names.includes('source-pin.json') && (!generation || names.includes('runtime.json')),
  'CORE_MANAGER_RECOVERY_UNKNOWN');
  const pinPath = join(directory, 'source-pin.json');
  await rootOwnedPath(pinPath);
  requireThat((await lstat(pinPath)).isFile() && (await lstat(pinPath)).nlink === 1,
    'CORE_MANAGER_RECOVERY_UNKNOWN');
  const pin = JSON.parse(await readFile(pinPath, 'utf8'));
  const root = join(directory, 'package');
  await verifyOwnedSourcePackage(root, pin);
  return { directory, root, pin };
}

// Recovery copies are data for identifying old owned entry bytes. They never
// select executable code, a workflow target or permission to continue work.
export async function managerRecoveryPackages() {
  const packages = [], retained = [];
  const selected = await selectedManager();
  if (selected !== managerRoot) {
    try {
      const pin = await readManagerPin(managerRoot);
      await verifyOwnedSourcePackage(managerRoot, pin);
      packages.push({ directory: managerRoot, root: managerRoot, pin, legacy: true });
    } catch (error) {
      if (!['ENOENT', 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE'].includes(error.code))
        retained.push(managerRoot);
    }
  }
  for (const entry of await readdir(base)) {
    if (!recoveryName.test(entry) && !managerGenerationName.test(entry)) continue;
    const path = join(base, entry);
    if (join(path, 'package') === selected) continue;
    try { packages.push(await readRecoveryPair(path)); }
    catch { retained.push(path); }
  }
  return { packages, retained };
}

export async function retainManagerPackage(pin) {
  if (pin !== undefined) await verifyOwnedSourcePackage(managerRoot, pin);
  else await rootOwnedPath(managerRoot);
  await assertNoSlotMounts(managerRoot);
  const directory = await mkdtemp(join(base, '.previous-'));
  let retained = false;
  let failed = false;
  try {
    if (pin !== undefined)
      await writeRetirementFile(join(directory, 'source-pin.json'), pin);
    await rename(managerRoot, join(directory, 'package'));
    retained = true;
    await syncRecoveryDirectory(directory);
    await syncRecoveryDirectory(base);
    return directory;
  } catch (error) { failed = true; throw error; }
  finally {
    if (!retained) await rm(directory, { recursive: true, force: true })
      .catch(error => { if (!failed) throw error; });
  }
}

export async function cleanupManagerRecovery(packages) {
  const retained = [];
  for (const pair of packages) {
    try {
      // The legacy fixed loader may have started without a package descriptor.
      // Its original package remains available for an explicit migration cleanup.
      requireThat(!pair.legacy && await selectedManager() !== pair.root,
        'CORE_MANAGER_RECOVERY_IN_USE');
      await readRecoveryPair(pair.directory);
      await requireNoResourceReferences(pair.directory,
        { code: 'CORE_MANAGER_RECOVERY_IN_USE' });
      await rm(pair.directory, { recursive: true });
    } catch { retained.push(pair.directory); }
  }
  await syncRecoveryDirectory(base);
  return retained;
}
