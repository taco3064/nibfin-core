import { cp, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm }
  from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { requireThat } from './identity.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { managerBase, managerPin, managerRoot, managerSelectionPath,
  selectedManager, readManagerPin } from './core-manager-generation.mjs';

async function verifyExistingSelection(root, pin, runtime) {
  if (root === managerRoot) {
    // Preserve any legacy package for old entry programs and recovery.
    for (const path of [root, managerPin]) {
      try { await rootOwnedPath(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
  }
  try {
    const selected = await readManagerPin(root);
    await verifyOwnedSourcePackage(root, selected);
    if (!isDeepStrictEqual(selected, pin)) return false;
    const path = join(dirname(root), 'runtime.json');
    await rootOwnedPath(path);
    const info = await lstat(path);
    requireThat(info.isFile() && info.nlink === 1,
      'ROLLOUT_MANAGER_METADATA_UNKNOWN');
    return isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), {
      nodePath: runtime.nodePath,
    });
  } catch (error) {
    if (!['ENOENT', 'SOURCE_MANIFEST_MISMATCH',
      'ROLLOUT_MANAGER_METADATA_UNAVAILABLE'].includes(error.code)) throw error;
    return false;
  }
}

export async function installVerifiedRolloutManager(source, pin, runtime,
  { published = async () => {}, observeSource = async () => {} } = {}) {
  await verifyOwnedSourcePackage(source, pin);
  await rootOwnedPath(dirname(managerBase));
  await mkdir(managerBase, { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath(managerBase);
  const previous = await selectedManager();
  if (await verifyExistingSelection(previous, pin, runtime))
    return { status: 'installed', source: pin, directory: previous };

  const staged = await mkdtemp(join(managerBase, '.prepared-'));
  const generation = 'generation-' + randomUUID();
  const directory = join(managerBase, generation);
  try {
    await chmod(staged, 0o755);
    const candidate = join(staged, 'package');
    await cp(source, candidate, { recursive: true, dereference: false });
    await verifyOwnedSourcePackage(candidate, pin);
    await writeRetirementFile(join(staged, 'source-pin.json'), pin);
    await writeRetirementFile(join(staged, 'runtime.json'),
      { nodePath: runtime.nodePath });
    await published('prepared', staged);
    requireThat(await selectedManager() === previous, 'ROLLOUT_MANAGER_SOURCE_CHANGED');
    // On interruption either generation remains fully usable. No live path is
    // rewritten beneath an existing process.
    await rename(staged, directory);
    await syncRecoveryDirectory(managerBase);
    await published('generation', directory);
    await observeSource();
    requireThat(await selectedManager() === previous, 'ROLLOUT_MANAGER_SOURCE_CHANGED');
    await writeRetirementFile(managerSelectionPath, { schemaVersion: 1, generation });
    await published('selected', directory);
    const root = join(directory, 'package');
    await verifyOwnedSourcePackage(root, pin);
    return { status: 'installed', source: pin, directory: root };
  } finally { await rm(staged, { recursive: true, force: true }); }
}
