import { lstat, readdir, unlink, rmdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { isSha, sha256, digest, requireThat } from './identity.mjs';
import { packageFinalization } from './package-finalization.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { isPackageSourcePath, includesPackagePath } from './source-package.mjs';
import { isSourceMode } from './source-mode.mjs';

export const packageName = /^core-(staged|before)-([a-f0-9]{40})$/;
const manifestName = 'nibfin-manifest.json';


export async function packageIdentity(path) {
  try {
    const stat = await lstat(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The original root-owned manifest remains authoritative during partial removal.
// Missing payload is allowed; changed or additional payload is never classified.
export async function classifyPackage(path, parent, {
  trust = rootOwnedPath,
} = {}) {
  requireThat(dirname(path) === parent && packageName.test(path.slice(parent.length + 1)),
    'PACKAGE_LAYOUT_UNCLASSIFIED');
  await trust(parent);
  await trust(path);
  const stat = await lstat(path);
  requireThat(stat.isDirectory(), 'PACKAGE_LAYOUT_UNCLASSIFIED');
  const manifestPath = join(path, manifestName);
  let bytes;
  try {
    await trust(manifestPath);
    bytes = await boundedHostFile(manifestPath, 4 * 1024 * 1024);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const identity = await packageIdentity(path);
      const marker = await packageFinalization(path, identity);
      requireThat(marker?.path === path && marker.identity === identity &&
        marker.repository === 'taco3064/nibfin-core' && isSha(marker.commit) &&
        (packageName.exec(path.slice(parent.length + 1))[1] !== 'staged' ||
          packageName.exec(path.slice(parent.length + 1))[2] === marker.commit) &&
        (await readdir(path)).length === 0, 'PACKAGE_METADATA_UNAVAILABLE');
      return { path, identity, manifest: JSON.stringify(marker), entries: [] };
    }
    throw error;
  }
  const manifest = JSON.parse(bytes);
  requireThat(manifest.schemaVersion === 1 &&
    manifest.repository === 'taco3064/nibfin-core' && isSha(manifest.commit) &&
    Array.isArray(manifest.files) && manifest.files.length > 0,
  'PACKAGE_METADATA_UNCLASSIFIED');
  requireThat(manifest.policyHash === digest(manifest.files.filter(file =>
    file.path.startsWith('src/'))) && manifest.skillsHash ===
    digest(manifest.files.filter(file => file.path.startsWith('skills/'))),
  'PACKAGE_METADATA_UNCLASSIFIED');
  const match = packageName.exec(path.slice(parent.length + 1));
  requireThat(match[1] !== 'staged' || match[2] === manifest.commit,
    'PACKAGE_METADATA_UNCLASSIFIED');
  const files = new Map(), directories = new Set();
  for (const file of manifest.files) {
    requireThat(isPackageSourcePath(file.path) && includesPackagePath(file.path) &&
      file.path !== manifestName &&
      !files.has(file.path) && isSourceMode(file.mode) &&
      Number.isSafeInteger(file.size) && file.size >= 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256), 'PACKAGE_METADATA_UNCLASSIFIED');
    files.set(file.path, file);
    for (let dir = dirname(file.path); dir !== '.'; dir = dirname(dir))
      directories.add(dir);
  }
  requireThat(files.has('package.json') && files.has('bin/nibfin-core.mjs') &&
    files.has('src/source-package.mjs'), 'PACKAGE_METADATA_UNCLASSIFIED');
  const entries = [];
  const walk = async prefix => {
    for (const name of await readdir(join(path, prefix))) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = join(path, relative);
      requireThat(resolve(target) === target, 'PACKAGE_CONTENT_UNCLASSIFIED');
      await trust(target);
      const item = await lstat(target);
      if (item.isDirectory()) {
        requireThat(directories.has(relative), 'PACKAGE_CONTENT_UNCLASSIFIED');
        await walk(relative);
        entries.push({ path: target, directory: true });
      } else {
        requireThat(item.isFile() && item.nlink === 1,
          'PACKAGE_CONTENT_UNCLASSIFIED');
        if (relative === manifestName) continue;
        const file = files.get(relative);
        requireThat(file && item.size === file.size &&
          Boolean(item.mode & 0o111) === (file.mode === '100755'),
        'PACKAGE_CONTENT_UNCLASSIFIED');
        const contents = await readFile(target);
        requireThat(sha256(contents) === file.sha256,
          'PACKAGE_CONTENT_UNCLASSIFIED');
        if (relative === 'package.json')
          requireThat(JSON.parse(contents).name === 'nibfin-core',
            'PACKAGE_METADATA_UNCLASSIFIED');
        entries.push({ path: target });
      }
    }
  };
  await walk('');
  return { path, identity: await packageIdentity(path), manifest: bytes, entries };
}

export async function removePackage(candidate, recheck, {
  trust = rootOwnedPath, unlinkFile = unlink, removeDirectory = rmdir,
} = {}) {
  // Reclassification validates every surviving entry before a retry as well.
  // The caller holds adoption/pool admission through this bounded operation.
  // Each retry repeats complete use/classification checks before its first effect.
  await recheck();
  for (const entry of candidate.entries) {
    requireThat(await packageIdentity(candidate.path) === candidate.identity,
      'PACKAGE_IDENTITY_CHANGED');
    await trust(entry.path);
    if (entry.directory) await rmdir(entry.path);
    else await unlink(entry.path);
  }
  await recheck();
  const metadata = JSON.parse(candidate.manifest);
  if ((await readdir(candidate.path)).includes(manifestName)) {
    // Persist only the already-validated identity and provenance. This marker
    // authorizes retry of an empty directory only, never a damaged payload.
    await packageFinalization(candidate.path, candidate.identity, {
      path: candidate.path, identity: candidate.identity,
      repository: metadata.repository, commit: metadata.commit,
    });
    await unlinkFile(join(candidate.path, manifestName));
    await syncRecoveryDirectory(candidate.path);
  }
  await removeDirectory(candidate.path);
  await syncRecoveryDirectory(dirname(candidate.path));
}
