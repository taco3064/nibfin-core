import { isDeepStrictEqual } from 'node:util';
import { lstat, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { digest, sha256, requireThat } from './identity.mjs';
import { isInstallationPin, includesPackagePath, isSafePackagePath,
  validateSourceManifest } from './source-package.mjs';
import { isSourceMode, matchesSourceMode } from './source-mode.mjs';
import { optionalStat, readRetirementFile, writeRetirementFile }
  from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

import { packageName, retirementEvidenceName }
  from './core-package-retirement-contract.mjs';
export { packageName, retirementEvidenceName }
  from './core-package-retirement-contract.mjs';
const manifestName = 'nibfin-manifest.json';
// Creation time also distinguishes an inode reused after a lost final response.
export const packageIdentity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const fileIdentity = stat =>
  `${packageIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function validateManifest(manifest) {
  const pin = { repository: manifest?.repository, commit: manifest?.commit,
    manifestHash: digest(manifest) };
  requireThat(isInstallationPin(pin) && manifest.schemaVersion === 1 &&
    Array.isArray(manifest.files) && manifest.files.length > 0 &&
    manifest.files.every(file => isSafePackagePath(file.path) &&
      includesPackagePath(file.path) && isSourceMode(file.mode) &&
      Number.isSafeInteger(file.size) && file.size >= 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256)) &&
    new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
  'PACKAGE_CONTENTS_UNKNOWN');
  validateSourceManifest(manifest, pin);
  return pin;
}

// No incomplete package is adopted. Only a durable deletion intent, created
// after full verification, permits missing entries during a subsequent retry.
export async function inspectRetirementPackage(parent, name) {
  requireThat(packageName.test(name), 'PACKAGE_NAMESPACE_UNKNOWN');
  await rootOwnedPath(parent);
  const path = join(parent, name);
  const evidencePath = join(parent, retirementEvidenceName(name));
  const evidenceStat = await optionalStat(evidencePath);
  if (evidenceStat) requireThat(evidenceStat.isFile() && evidenceStat.nlink === 1,
    'PACKAGE_CONTENTS_UNKNOWN');
  const intent = evidenceStat ? await readRetirementFile(evidencePath) : null;
  if (evidenceStat) requireThat(intent && typeof intent === 'object' &&
    !Array.isArray(intent), 'PACKAGE_CONTENTS_UNKNOWN');
  const evidenceIdentity = evidenceStat ? fileIdentity(evidenceStat) : null;
  const stat = await optionalStat(path);
  if (!stat) {
    requireThat(intent?.name === name && typeof intent.identity === 'string',
      'PACKAGE_CONTENTS_UNKNOWN');
    validateManifest(intent.manifest);
    return { path, name, evidencePath, evidenceIdentity, intent, absent: true };
  }
  await rootOwnedPath(path);
  requireThat(stat.isDirectory(), 'PACKAGE_CONTENTS_UNKNOWN');
  const identity = packageIdentity(stat);
  let manifest;
  if (intent) {
    requireThat(intent.name === name && intent.identity === identity,
      'PACKAGE_IDENTITY_CHANGED');
    manifest = intent.manifest;
  } else {
    await rootOwnedPath(join(path, manifestName));
    manifest = JSON.parse(await readFile(join(path, manifestName), 'utf8'));
  }
  const pin = validateManifest(manifest);
  if (name.startsWith('core-staged-')) requireThat(
    packageName.exec(name)[2] === pin.commit, 'PACKAGE_SOURCE_MISMATCH');
  if (!intent) await verifyOwnedSourcePackage(path, pin);
  const candidate = { path, name, identity, pin, manifest, evidencePath,
    evidenceIdentity, intent };
  await inspectRemainingContents(candidate);
  return candidate;
}

async function inspectIntent(candidate) {
  const { evidencePath, evidenceIdentity, intent } = candidate;
  await rootOwnedPath(evidencePath);
  requireThat(fileIdentity(await lstat(evidencePath)) === evidenceIdentity &&
    isDeepStrictEqual(await readRetirementFile(evidencePath), intent) &&
    fileIdentity(await lstat(evidencePath)) === evidenceIdentity,
  'PACKAGE_IDENTITY_CHANGED');
}

async function inspectRemainingContents(candidate) {
  const { path, manifest, identity } = candidate;
  await rootOwnedPath(path);
  requireThat(packageIdentity(await lstat(path)) === identity,
    'PACKAGE_IDENTITY_CHANGED');
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const directories = new Set();
  for (const file of files.keys()) {
    for (let parent = dirname(file); parent !== '.'; parent = dirname(parent))
      directories.add(parent);
  }
  const observed = [];
  const walk = async prefix => {
    for (const name of await readdir(join(path, prefix))) {
      const relative = prefix ? `${prefix}/${name}` : name;
      requireThat(isSafePackagePath(relative), 'PACKAGE_CONTENTS_UNKNOWN');
      const entry = join(path, relative);
      await rootOwnedPath(entry);
      const stat = await lstat(entry);
      if (stat.isDirectory()) {
        requireThat(directories.has(relative), 'PACKAGE_CONTENTS_UNKNOWN');
        await walk(relative);
        observed.push({ relative, identity: packageIdentity(stat), directory: true });
        continue;
      }
      requireThat(stat.isFile() && stat.nlink === 1, 'PACKAGE_CONTENTS_UNKNOWN');
      const bytes = await readFile(entry);
      const expected = files.get(relative);
      if (relative === manifestName) requireThat(
        digest(JSON.parse(bytes.toString())) === digest(manifest),
        'PACKAGE_CONTENTS_CHANGED');
      else requireThat(expected && bytes.length === expected.size &&
        sha256(bytes) === expected.sha256 && matchesSourceMode(
          stat.mode & 0o111 ? '100755' : '100644', expected.mode),
      'PACKAGE_CONTENTS_CHANGED');
      requireThat(fileIdentity(await lstat(entry)) === fileIdentity(stat),
        'PACKAGE_IDENTITY_CHANGED');
      observed.push({ relative, identity: fileIdentity(stat), directory: false });
    }
  };
  await walk('');
  return observed;
}

async function removeAndReadBack(path, directory, effect) {
  try { await effect(path, directory); }
  catch (error) {
    // A lost response is reconciled against actual absence, never replayed on
    // a replacement. A still-present entry is inspected on the normal retry.
    if (await optionalStat(path)) throw error;
  }
  requireThat(!await optionalStat(path), 'PACKAGE_REMOVAL_PENDING');
  await syncRecoveryDirectory(dirname(path));
}

// The caller owns the existing exclusive source-lifetime gate. No recursive
// removal: each remaining entry must still match its verified attribution.
export async function removeRetirementPackage(candidate, recheck, {
  effect = (path, directory) => directory ? rmdir(path) : unlink(path),
} = {}) {
  if (candidate.absent) {
    requireThat(!await optionalStat(candidate.path), 'PACKAGE_IDENTITY_CHANGED');
    await inspectIntent(candidate);
    await removeAndReadBack(candidate.evidencePath, false, effect);
    return;
  }
  await recheck(candidate);
  await inspectRemainingContents(candidate);
  if (!candidate.intent) {
    requireThat(!await optionalStat(candidate.evidencePath), 'PACKAGE_IDENTITY_CHANGED');
    candidate.intent = { name: candidate.name, identity: candidate.identity,
      manifest: candidate.manifest };
    await writeRetirementFile(candidate.evidencePath, candidate.intent);
    candidate.evidenceIdentity = fileIdentity(await lstat(candidate.evidencePath));
  }
  await inspectIntent(candidate);
  const entries = await inspectRemainingContents(candidate);
  // Keep manifest and durable intent until all attributed contents are gone.
  entries.sort((a, b) => (a.relative === manifestName ? 1 :
    b.relative === manifestName ? -1 : b.relative.split('/').length -
      a.relative.split('/').length));
  await recheck(candidate);
  for (const entry of entries) {
    if (entry.relative === manifestName) {
      await recheck(candidate);
      await inspectRemainingContents(candidate);
    }
    await inspectIntent(candidate);
    await rootOwnedPath(candidate.path);
    requireThat(packageIdentity(await lstat(candidate.path)) === candidate.identity,
      'PACKAGE_IDENTITY_CHANGED');
    const path = join(candidate.path, entry.relative);
    await rootOwnedPath(path);
    const current = await lstat(path);
    // Directory timestamps change when its verified children are removed.
    requireThat(entry.directory ? current.isDirectory() &&
      packageIdentity(current) === entry.identity :
      fileIdentity(current) === entry.identity, 'PACKAGE_CONTENTS_CHANGED');
    await removeAndReadBack(path, entry.directory, effect);
  }
  await recheck(candidate);
  await inspectIntent(candidate);
  requireThat(packageIdentity(await lstat(candidate.path)) === candidate.identity,
    'PACKAGE_IDENTITY_CHANGED');
  await removeAndReadBack(candidate.path, true, effect);
  await inspectIntent(candidate);
  await removeAndReadBack(candidate.evidencePath, false, effect);
}
