import { command } from './process.mjs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedHostFile, hostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { managedBase, managedPaths, credentialDirectories } from
  './managed-credential-files.mjs';

import { prepareSharedAccounts } from './shared-host-setup.mjs';

const profileFile = '/etc/nibfin/shared-host-profile.json';

async function trustedJson(path) {
  await rootOwnedPath(path);
  return JSON.parse(await boundedHostFile(path, 262144));
}

function repositoryIdentity(profile) {
  const value = profile.repository?.approval;
  requireThat(value?.kind === 'repository-admission-v1',
    'MANAGED_CREDENTIAL_REPOSITORY_NOT_ADOPTED');
  return { repository: value.repository, repositoryId: value.repositoryId };
}

// Installed legacy services are outside the Core package directory. Before
// enrollment, prove they cannot consume the new token through their old path.
async function verifyLegacyRollout(prepare) {
  const path = '/usr/local/libexec/nibfin/host-auto-rollout.py';
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await rootOwnedPath(path);
  const expected = join(coreRoot, 'scripts/host-auto-rollout.py');
  requireThat(await boundedHostFile(path, 65536) ===
    await boundedHostFile(expected, 65536),
  'MANAGED_CREDENTIAL_LEGACY_CONSUMER_UPGRADE_REQUIRED');
  if (!prepare) return;
  await rootOwnedPath('/usr/bin/systemctl');
  const { stdout } = await command('/usr/bin/systemctl', [
    'show', '--property=ActiveState,SubState,MainPID', 'nibfin-rollout.service',
  ], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 4096 });
  const values = new Map(stdout.toString().trim().split('\n').map(line => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  requireThat(values.get('ActiveState') === 'inactive' &&
    values.get('SubState') === 'dead' && values.get('MainPID') === '0',
  'MANAGED_CREDENTIAL_LEGACY_CONSUMER_PENDING');
}

export async function managedCredentialHost(administrator = false, prepare = false) {
  requireThat(process.platform === 'linux' && coreRoot === '/opt/nibfin/core' &&
    (administrator ? process.getuid() === 0 : process.getuid() > 0),
  'MANAGED_CREDENTIAL_REQUIRES_LOCAL_ADMIN');
  await rootOwnedPath(coreRoot);
  let host, beforeAdoption = false;
  try { host = await trustedJson(hostFile); }
  catch (error) {
    if (error.code !== 'ENOENT' || !administrator) throw error;
    beforeAdoption = true;
    const profile = await trustedJson(profileFile);
    const binding = profile.credentialIntake;
    requireThat(binding?.schemaVersion === 1 &&
      Array.isArray(binding.repositories) && binding.repositories.length === 2,
    'MANAGED_CREDENTIAL_TRUSTED_BINDING_REQUIRED');
    requireThat(binding.installation?.directory === coreRoot &&
      isId(binding.memberId) && Object.entries(managedPaths).every(
        ([key, path]) => profile[key] === path),
    'MANAGED_CREDENTIAL_HOST_INVALID');
    await verifyInstalledSource(coreRoot, binding.installation.pin);
    if (prepare) await prepareSharedAccounts(profile);
    const stat = await lstat(dirname(profile.tokenFile));
    host = { ...profile, kind: 'single-host-linux-v1', uid: stat.uid, gid: stat.gid,
      memberId: binding.memberId,
      installation: binding.installation,
      credentialRepositories: binding.repositories };
  }
  requireThat(host.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    isId(host.uid) && isId(host.memberId) &&
    (administrator || host.uid === process.getuid()) &&
    host.installation?.directory === coreRoot &&
    Object.entries(managedPaths).every(([key, path]) => host[key] === path),
  'MANAGED_CREDENTIAL_HOST_INVALID');
  await rootOwnedPath(dirname(managedBase));
  await credentialDirectories(host);
  const base = await lstat(managedBase);
  requireThat(base.isDirectory() && base.uid === host.uid &&
    (base.mode & 0o777) === 0o700, 'MANAGED_CREDENTIAL_HOST_INVALID');
  host.gid = (await lstat(dirname(host.tokenFile))).gid;
  await verifyInstalledSource(coreRoot, host.installation.pin);
  await verifyLegacyRollout(prepare);
  if (!beforeAdoption) {
    const execution = host.sharedRunner?.runner ?? host.repository?.runner;
    requireThat(execution && isId(execution.repositoryId),
      'MANAGED_CREDENTIAL_REPOSITORY_NOT_ADOPTED');
    const repositories = [repositoryIdentity(host), {
      repository: execution.repository, repositoryId: execution.repositoryId,
    }];
    const peers = host.wakePeerFiles ?? [];
    requireThat(Array.isArray(peers) && peers.length <= 10, 'INVALID_WAKE_PEERS');
    for (const path of peers) {
      requireThat(/^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path),
        'INVALID_WAKE_PEER_PATH');
      const peer = await trustedJson(path);
      requireThat(peer.memberId === host.memberId && peer.uid === host.uid &&
        peer.stateRoot === host.stateRoot &&
        digest(peer.installation) === digest(host.installation),
      'MANAGED_CREDENTIAL_HOST_INVALID');
      repositories.push(repositoryIdentity(peer));
    }
    host.credentialRepositories = [...new Map(repositories.map(value =>
      [value.repositoryId, value])).values()];
  }
  return host;
}

export async function hasManagedHost() {
  // The legacy/manual path is unchanged; no implicit enrollment.
  let host;
  try { host = await trustedJson(hostFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    host = managedPaths;
  }
  if (host.tokenFile !== managedPaths.tokenFile) return false;
  try {
    await lstat(join(dirname(host.tokenFile), 'managed.json'));
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
