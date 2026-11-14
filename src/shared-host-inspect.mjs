import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { isId, requireThat } from './identity.mjs';
import { controllerRoute } from './controller-contract.mjs';
import { sharedRunner } from './shared-runner.mjs';

// Return only native registration identifiers from trusted host adoption.
// This does not test execution or grant adoption to a new repository.
export function sharedHostRegistrations(host) {
  requireThat(host.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    host.installation?.directory === coreRoot && controllerRoute(host),
    'INVALID_HOST_ADOPTION');
  const repositoryId = host.repository?.approval?.repositoryId;
  const second = host.sharedRunner?.additionalRunner;
  requireThat(isId(repositoryId) && isId(second?.uid), 'SHARED_RUNNER_NOT_ADOPTED');
  const target = { repositoryId };
  const bindings = [host.runnerUid, second.uid]
    .map(uid => sharedRunner(host, target, uid).runner);
  requireThat(bindings.every(({ runnerName }) =>
    typeof runnerName === 'string' && runnerName), 'SHARED_RUNNER_NOT_ADOPTED');
  return {
    schemaVersion: 1,
    repository: bindings[0].repository,
    repositoryId: bindings[0].repositoryId,
    memberId: host.memberId,
    runners: bindings.map(({ runnerId, runnerName }) =>
      ({ id: runnerId, name: runnerName })),
  };
}

export async function inspectSharedHost() {
  requireThat(process.platform === 'linux', 'UNSUPPORTED_STAGE_HOST');
  await Promise.all([rootOwnedPath(hostFile), rootOwnedPath(coreRoot)]);
  const bytes = await boundedHostFile(hostFile, 256 * 1024);
  const host = JSON.parse(bytes);
  const result = sharedHostRegistrations(host);
  await verifyInstalledSource(coreRoot, host.installation.pin);
  requireThat(await boundedHostFile(hostFile, 256 * 1024) === bytes,
    'HOST_ADOPTION_CHANGED');
  return result;
}
