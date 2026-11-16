import { mkdir } from 'node:fs/promises';
import { isDigest, isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { coreRoot, hostFile } from './host-adoption.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { engine } from './engine-contract.mjs';
import { installManagedEngine } from './engine-install.mjs';
import { installEngineFile, optionalStat } from './engine-files.mjs';
import { credentialBindingFile } from './managed-credential-files.mjs';
import { prepareManagedSharedHost } from './managed-resource-install.mjs';
import { withSharedAdoptionLock } from './shared-peer-adoption.mjs';

export function managedOnboardingBinding(value) {
  requireThat(value && Object.keys(value).sort().join(',') ===
    'memberId,pin,repositories,schemaVersion' && value.schemaVersion === 1 &&
    isId(value.memberId) && value.pin?.repository === 'taco3064/nibfin-core' &&
    isSha(value.pin.commit) && isDigest(value.pin.manifestHash) &&
    isDigest(value.pin.archiveHash) && Array.isArray(value.repositories) &&
    value.repositories.length === 2, 'MANAGED_ONBOARDING_BINDING_INVALID');
  const repositories = value.repositories.map(entry => {
    requireThat(entry && isId(entry.repositoryId) &&
      Object.keys(entry).sort().join(',') === 'repository,repositoryId',
    'MANAGED_ONBOARDING_BINDING_INVALID');
    repoPath(entry.repository);
    return { repository: entry.repository, repositoryId: entry.repositoryId };
  });
  const { repository, commit, manifestHash, archiveHash } = value.pin;
  return { schemaVersion: 1, memberId: value.memberId,
    installation: { directory: '/opt/nibfin/core',
      pin: { repository, commit, manifestHash, archiveHash } }, repositories };
}

export async function prepareManagedOnboarding(input = process.stdin) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'MANAGED_ONBOARDING_REQUIRES_ADMIN');
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    length += chunk.length;
    requireThat(length <= 4096, 'MANAGED_ONBOARDING_BINDING_INVALID');
    chunks.push(chunk);
  }
  const binding = managedOnboardingBinding(JSON.parse(Buffer.concat(chunks).toString()));
  const { pin } = binding.installation;
  await verifyInstalledSource(coreRoot, pin);
  await rootOwnedPath('/etc');
  await mkdir('/etc/nibfin', { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath('/etc/nibfin');
  await withSharedAdoptionLock(async () => {
    requireThat(!await optionalStat(hostFile), 'MANAGED_ONBOARDING_ALREADY_ADOPTED');
    await installEngineFile(credentialBindingFile, JSON.stringify(binding) + '\n');
    await installEngineFile(engine.plan, JSON.stringify({ pin }) + '\n');
  });
  await installManagedEngine(true);
  return prepareManagedSharedHost(true);
}
