import { hostFile, coreRoot } from './host-adoption.mjs';
import { controllerRoute } from './controller-contract.mjs';
import { installedProvider } from './provider-binding.mjs';
import { sharedRunner } from './shared-runner.mjs';
import { sharedPeerIdentity } from './shared-host-inspect.mjs';
import { repoPath } from './github-read.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { readObservationFile } from './local-work-files.mjs';
import { reason, safeName } from './local-work-values.mjs';

function validateHost(host, subject) {
  requireThat(host?.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    host.installation?.directory === coreRoot && controllerRoute(host),
  'UNSUPPORTED_HOST');
  requireThat(host.memberId === subject.id, 'SUBJECT_MISMATCH');
}
function routeOf(host, subject) {
  validateHost(host, subject);
  const record = host.repository;
  const repositoryId = record?.approval?.repositoryId;
  const repository = record?.runner?.repository;
  repoPath(repository);
  requireThat(isId(repositoryId) && record.runner.repositoryId === repositoryId &&
    record.runner.memberId === subject.id, 'UNVERIFIED_BINDING');
  return { repositoryId, repository };
}

// Internal seam for disposable tests; the public collector never accepts paths
// or a host object. Peer file names come exclusively from root-owned adoption.
export async function discoverLocalHost(subject, read = readObservationFile) {
  requireThat(process.platform === 'linux', 'UNSUPPORTED_HOST');
  const snapshots = new Map();
  const sourceTimes = new WeakMap();
  const load = async path => {
    const file = await read(path, 0, 256 * 1024);
    snapshots.set(path, file.bytes);
    const host = JSON.parse(file.bytes);
    sourceTimes.set(host, file.sourceTime);
    return host;
  };
  const primary = await load(hostFile);
  validateHost(primary, subject);
  const provider = installedProvider(primary);
  const paths = primary.wakePeerFiles ?? [];
  requireThat(Array.isArray(paths) && paths.length <= 10 &&
    new Set(paths).size === paths.length && paths.every(path =>
      /^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path)),
  'UNVERIFIED_BINDING');
  const hosts = [primary]; const errors = [];
  const legacy = new Set();
  for (const path of paths) {
    try {
      const peer = await load(path);
      validateHost(peer, subject);
      requireThat(peer.uid === primary.uid && peer.stateRoot === primary.stateRoot &&
        digest(peer.installation) === digest(primary.installation),
      'UNVERIFIED_BINDING');
      // Legacy secondary views carry the primary provider binding. Other views
      // must independently validate their complete installed registration record.
      let binding;
      try { binding = installedProvider(peer); }
      catch (error) {
        if (!primary.sharedRunner?.additionalRunner ||
          !sharedPeerIdentity(primary, peer)) throw error;
        legacy.add(peer);
      }
      if (binding) requireThat(binding.provider === provider.provider &&
        digest(binding.components) === digest(provider.components) &&
        digest(binding.modelProfile) === digest(provider.modelProfile) &&
        binding.credentialKind === provider.credentialKind &&
        peer.authFile === primary.authFile, 'PROVIDER_VIEW_MISMATCH');
      routeOf(peer, subject);
      hosts.push(peer);
    } catch (error) { errors.push(reason(error)); }
  }
  const routes = hosts.map(host => ({ host, route: routeOf(host, subject) }));
  const bindings = new Map();
  for (const host of hosts) {
    const source = legacy.has(host) ? primary : host;
    const candidates = host.sharedRunner
      ? [host.sharedRunner.runner,
        ...(host.sharedRunner.additionalRunner ? [{ ...host.sharedRunner.runner,
          runnerId: host.sharedRunner.additionalRunner.id,
          runnerName: host.sharedRunner.additionalRunner.name }] : [])]
      : [host.repository.runner];
    for (const expected of candidates) {
      const id = expected?.runnerId;
      requireThat(isId(id) && isId(expected.repositoryId) &&
        isId(expected.workflowId) &&
        /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expected.workflowPath) &&
        expected.memberId === subject.id, 'UNVERIFIED_BINDING');
      repoPath(expected.repository);
      safeName(expected.runnerName);
      safeName(expected.jobName);
      const adopted = [];
      for (const { route } of routes) {
        if (host.sharedRunner) {
          if (!host.sharedRunner.repositories?.includes(route.repositoryId)) continue;
          // Keep all existing enrollment checks; the observation collection is
          // independent of the number of slots in each individual host view.
          if (id === host.sharedRunner.runner.runnerId)
            sharedRunner(source, route, id === source.sharedRunner.runner.runnerId
              ? source.runnerUid : source.sharedRunner.additionalRunner.uid);
          else sharedRunner(source, route, source.sharedRunner.additionalRunner.uid);
        } else if (route.repositoryId !== host.repository.approval.repositoryId) continue;
        adopted.push(route);
      }
      const key = `${expected.repositoryId}:${id}`;
      const previous = bindings.get(key);
      requireThat(!previous || previous.expected.runnerName === expected.runnerName &&
        previous.expected.repository === expected.repository &&
        previous.expected.workflowId === expected.workflowId &&
        previous.expected.workflowPath === expected.workflowPath,
      'UNVERIFIED_BINDING');
      const all = [...(previous?.routes ?? []), ...adopted];
      bindings.set(key, { expected, shared: Boolean(host.sharedRunner),
        hostId: `local-controller-${primary.uid}`, sourceTime: sourceTimes.get(host),
        routes: [...new Map(all.map(route => [route.repositoryId, route])).values()] });
    }
  }
  const confirm = async () => {
    for (const [path, bytes] of snapshots) {
      requireThat((await read(path, 0, 256 * 1024)).bytes === bytes,
        'OBSERVATION_CHANGED');
    }
  };
  return { bindings: [...bindings.values()], routes: [...new Map(routes.map(item =>
      [item.route.repositoryId, item.route])).values()],
    stateRoot: primary.stateRoot, uid: primary.uid, errors, confirm };
}
