import { lstat, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { verifySharedFile } from './shared-platform.mjs';
import { installedRunnerIdentityFile, installedRunnerIdentity,
  legacyRunnerIdentity, verifyRunnerIdentityFiles }
  from './installed-runner-identity.mjs';

// Readers never manufacture trust from root ownership or an executable's own
// digest. An absent record can use only the known verified bootstrap bytes.
export async function readInstalledRunnerIdentity(directory, local, target, {
  inspect = rootOwnedPath, read = boundedHostFile, verify = verifySharedFile,
} = {}) {
  const path = join(directory, installedRunnerIdentityFile);
  let identity;
  try {
    await inspect(path);
    identity = installedRunnerIdentity(JSON.parse(await read(path, 65536)),
      local, target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    identity = legacyRunnerIdentity(local, target);
  }
  await verifyRunnerIdentityFiles(directory, identity, target, verify);
  return identity;
}

// Publication belongs to a root installer after package verification. The
// registration and installed executable bytes are checked again at publication;
// replacing the metadata never changes registration, admission or credentials.
export async function publishInstalledRunnerIdentity(directory, identity, target) {
  await rootOwnedPath(directory);
  const path = join(directory, '.runner');
  await rootOwnedPath(path);
  const local = JSON.parse((await boundedHostFile(path, 65536)).replace(/^\uFEFF/, ''));
  installedRunnerIdentity(identity, local, target);
  await verifyRunnerIdentityFiles(directory, identity, target);
  const scratch = await mkdtemp(join(directory, '.nibfin-identity-'));
  try {
    const staged = join(scratch, 'identity.json');
    const file = await open(staged, 'wx', 0o644);
    try {
      await file.chown(0, 0);
      await file.chmod(0o644);
      await file.writeFile(JSON.stringify(identity) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(staged, join(directory, installedRunnerIdentityFile));
    await syncRecoveryDirectory(directory);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Re-enter a partially completed bootstrap install without replacing known good
// facts. A stale record is repairable only if the installed bytes independently
// match the trusted bootstrap package. Newer installs recover from their verified
// archive via deriveOfficialRunnerIdentity and publication, not a hash enrollment.
export async function ensureInstalledRunnerIdentity(directory, local, target) {
  let identity;
  try {
    identity = await readInstalledRunnerIdentity(directory, local, target);
    if (await lstat(join(directory, installedRunnerIdentityFile))) return identity;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const recoverable = ['INVALID_INSTALLED_RUNNER_IDENTITY',
        'INVALID_RUNNER_RELEASE', 'SHARED_ARTIFACT_DIGEST_MISMATCH',
        'SHARED_PLATFORM_MISMATCH'];
      if (!(error instanceof SyntaxError) && !recoverable.includes(error.code))
        throw error;
      identity = legacyRunnerIdentity(local, target);
      await verifyRunnerIdentityFiles(directory, identity, target);
    }
  }
  identity ??= legacyRunnerIdentity(local, target);
  await publishInstalledRunnerIdentity(directory, identity, target);
  return identity;
}
