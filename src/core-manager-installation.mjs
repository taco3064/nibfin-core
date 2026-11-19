import { cp, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { managerRoot, managerPin, readManagerPin } from './rollout-manager-context.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { requireThat } from './identity.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { retainManagerPackage } from './core-manager-recovery.mjs';

async function ensureMetadata(path, expected) {
  const exists = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (exists) {
    await rootOwnedPath(path);
    requireThat(exists.isFile() && exists.nlink === 1,
      'ROLLOUT_MANAGER_METADATA_UNKNOWN');
    try {
      if (isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), expected))
        return false;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  await writeRetirementFile(path, expected);
  return true;
}

export async function publishManagerMetadata(pin, runtime,
  { published = async () => {} } = {}) {
  if (await ensureMetadata(managerPin, pin)) await published('pin');
  if (await ensureMetadata(join(dirname(managerRoot), 'runtime.json'),
    { nodePath: runtime.nodePath })) await published('runtime');
  await syncRecoveryDirectory(dirname(managerRoot));
  return { status: 'installed', source: pin };
}

// Both installed administration and verified bootstrap use this publication.
// Its callers hold the existing /etc/nibfin directory gate throughout source use.
export async function installVerifiedRolloutManager(source, pin, runtime,
  { published = async () => {} } = {}) {
  await verifyOwnedSourcePackage(source, pin);
  const base = dirname(managerRoot);
  await rootOwnedPath(dirname(base));
  await mkdir(base, { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath(base);
  const previous = await lstat(managerRoot).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  let installedPin;
  if (previous) {
    try {
      await verifyOwnedSourcePackage(managerRoot, pin);
      // The complete published tree is stronger than a missing/stale receipt.
      return await publishManagerMetadata(pin, runtime, { published });
    } catch (error) {
      if (error.code !== 'SOURCE_MANIFEST_MISMATCH') throw error;
    }
  }
  // Unpublished copying is disposable, not another operation journal. A crash
  // cannot turn an older prepared tree into a prerequisite for the next source.
  const staged = await mkdtemp(join(base, '.prepared-'));
  try {
    await chmod(staged, 0o755);
    await cp(source, staged, { recursive: true, force: true, dereference: false });
    await verifyOwnedSourcePackage(staged, pin);
    await published('prepared', staged);
    if (previous) {
      try {
        installedPin = await readManagerPin();
        await verifyOwnedSourcePackage(managerRoot, installedPin);
      } catch (error) {
        if (!['ROLLOUT_MANAGER_METADATA_UNAVAILABLE', 'SOURCE_MANIFEST_MISMATCH']
          .includes(error.code)) throw error;
        installedPin = undefined;
      }
      await retainManagerPackage(installedPin);
      await published('previous');
    }
    // Readers hold the same gate. Publish metadata while the fixed manager is
    // absent, then its complete tree: a crash cannot leave C bytes with B's pin.
    await publishManagerMetadata(pin, runtime, { published });
    await rename(staged, managerRoot);
    await published('manager');
    await syncRecoveryDirectory(base);
    await verifyOwnedSourcePackage(managerRoot, pin);
    return { status: 'installed', source: pin };
  } finally { await rm(staged, { recursive: true, force: true }); }
}
