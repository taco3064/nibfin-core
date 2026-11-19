import { installedProvider, compareProviderViews } from './provider-binding.mjs';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { controllerRoute } from './controller-contract.mjs';
import { sharedRepository, sharedRunner } from './shared-runner.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';

// Return only native registration identifiers from trusted host adoption.
// This does not test execution or grant adoption to a new repository.
export function sharedHostRegistrations(host) {
  return readSharedHostRegistrations(host, coreRoot);
}

export function managerHostRegistrations(host, context) {
  return readSharedHostRegistrations(host,
    requireManagerContext(context).installationRoot);
}

function readSharedHostRegistrations(host, installationRoot) {
  requireThat(host.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    host.installation?.directory === installationRoot && controllerRoute(host),
    'INVALID_HOST_ADOPTION');
  const repositoryId = host.repository?.approval?.repositoryId;
  const second = host.sharedRunner?.additionalRunner;
  requireThat(isId(repositoryId) && isId(second?.uid), 'SHARED_RUNNER_NOT_ADOPTED');
  const target = { repositoryId };
  const bindings = [host.runnerUid, second.uid]
    .map(uid => sharedRunner(host, target, uid).runner);
  requireThat(bindings.every(({ runnerName }) =>
    typeof runnerName === 'string' && runnerName), 'SHARED_RUNNER_NOT_ADOPTED');
  installedProvider(host);
  return {
    schemaVersion: 1,
    repository: bindings[0].repository,
    repositoryId: bindings[0].repositoryId,
    memberId: host.memberId,
    runners: bindings.map(({ runnerId, runnerName }) =>
      ({ id: runnerId, name: runnerName })),
  };
}

export function sharedPeerIdentity(primary, peer) {
  compareProviderViews(primary, peer);
  requireThat(peer.uid === primary.uid && peer.memberId === primary.memberId &&
    peer.stateRoot === primary.stateRoot &&
    digest(peer.installation) === digest(primary.installation),
  'SHARED_REPOSITORY_NOT_ADOPTED');
  const second = primary.sharedRunner.additionalRunner;
  if (peer.runnerUid !== second.uid) return false;
  const expected = { ...primary.sharedRunner.runner,
    runnerId: second.id, runnerName: second.name };
  requireThat(controllerRoute(peer) &&
      digest(peer.sharedRunner?.runner ?? null) === digest(expected) &&
      digest(peer.sharedRunner.caller) === digest(primary.sharedRunner.caller) &&
      Array.isArray(peer.sharedRunner.repositories) &&
      digest([...peer.sharedRunner.repositories].sort()) ===
        digest([...primary.sharedRunner.repositories].sort()),
  'SHARED_RUNNER_SLOT_VIEW_MISMATCH');
  return true;
}

export async function inspectSharedHost() {
  await rootOwnedPath(coreRoot);
  return inspectSharedInstallation(coreRoot,
    pin => verifyInstalledSource(coreRoot, pin));
}

export async function inspectManagerHost(context) {
  const admitted = requireManagerContext(context);
  return inspectSharedInstallation(admitted.installationRoot,
    admitted.verifyInstallation);
}

async function inspectSharedInstallation(installationRoot, verify) {
  requireThat(process.platform === 'linux', 'UNSUPPORTED_STAGE_HOST');
  await rootOwnedPath(hostFile);
  const bytes = await boundedHostFile(hostFile, 256 * 1024);
  const host = JSON.parse(bytes);
  const result = readSharedHostRegistrations(host, installationRoot);
  await verify(host.installation.pin);
  const peerReads = new Map();
  const readPeer = async path => {
    if (!peerReads.has(path)) {
      await rootOwnedPath(path);
      peerReads.set(path, await boundedHostFile(path, 256 * 1024));
    }
    return JSON.parse(peerReads.get(path));
  };
  const ids = host.sharedRunner.repositories;
  requireThat(ids.every(isId) && new Set(ids).size === ids.length,
    'SHARED_REPOSITORY_NOT_ADOPTED');
  let slotViews = 0;
  for (const id of ids) {
    const peer = await sharedRepository(host, id, readPeer);
    if (peer !== host && sharedPeerIdentity(host, peer)) slotViews++;
  }
  requireThat(slotViews <= 1, 'SHARED_RUNNER_SLOT_VIEW_MISMATCH');
  for (const [path, observed] of peerReads) {
    requireThat(await boundedHostFile(path, 256 * 1024) === observed,
      'HOST_ADOPTION_CHANGED');
  }
  requireThat(await boundedHostFile(hostFile, 256 * 1024) === bytes,
    'HOST_ADOPTION_CHANGED');
  return { ...result, adoptedRepositoryIds: ids };
}
