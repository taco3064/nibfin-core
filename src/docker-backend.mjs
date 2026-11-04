import { dirname, isAbsolute } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { executionProfile } from './execution-profiles.mjs';
import { rootOwnedPath } from './host-paths.mjs';

export const rootlessBackend = Object.freeze({ kind: 'linux-rootless-docker-v1' });
export const rootfulSocket = '/run/nibfin-engine/docker.sock';

// Only the installed composition supplies this administrative backend contract.
export function dockerBackend(value = rootlessBackend) {
  const selected = executionProfile(value.kind);
  if (selected.dockerMode === 'rootful') {
    const n = value.namespace;
    requireThat(
      n &&
        Object.keys(n).sort().join(',') === 'gidStart,size,uidStart' &&
        [n.uidStart, n.gidStart].every(
          (x) => Number.isSafeInteger(x) && x >= 65536 && x <= 4294901760,
        ) &&
        n.size === 65536,
      'INVALID_DOCKER_NAMESPACE',
    );
  }
  return Object.freeze({ ...structuredClone(value), mode: selected.dockerMode });
}

export function validDockerEndpoint(config, backend) {
  return (
    isAbsolute(config.docker) &&
    (backend.mode === 'rootless'
      ? /^\/run\/user\/[1-9]\d*\/docker\.sock$/.test(config.socket)
      : config.docker === '/usr/bin/docker' && config.socket === rootfulSocket)
  );
}

export async function verifyDockerSocket(socket, backend, host) {
  requireThat(host.platform === 'linux' && host.uid > 0, 'UNSUPPORTED_SANDBOX_HOST');
  const stat = await host.lstat(socket);
  requireThat(
    stat.isSocket() &&
      (await host.realpath(socket)) === socket &&
      (stat.mode & 0o007) === 0,
    'UNTRUSTED_DOCKER_SOCKET',
  );
  if (backend.mode === 'rootless') {
    requireThat(
      socket === `/run/user/${host.uid}/docker.sock` && stat.uid === host.uid,
      'UNTRUSTED_DOCKER_SOCKET',
    );
  } else {
    requireThat(
      socket === rootfulSocket &&
        host.uid < 65536 &&
        stat.uid === 0 &&
        stat.gid > 0 &&
        (stat.mode & 0o777) === 0o660 &&
        (host.gids ?? process.getgroups()).includes(stat.gid),
      'UNTRUSTED_ROOTFUL_DOCKER_SOCKET',
    );
    await (host.rootOwnedPath ?? rootOwnedPath)(dirname(socket));
    await (host.rootOwnedPath ?? rootOwnedPath)('/usr/bin/docker');
  }
}

export function dockerInfo(info, backend = dockerBackend()) {
  const security = info?.SecurityOptions ?? [];
  requireThat(
    security.includes('name=seccomp,profile=builtin') &&
      info.CgroupVersion === '2' &&
      info.CgroupDriver === 'systemd' &&
      ['MemoryLimit', 'PidsLimit', 'CpuCfsPeriod', 'CpuCfsQuota'].every(
        (key) => info[key] === true,
      ),
    'DOCKER_ISOLATION_UNAVAILABLE',
  );
  requireThat(
    backend.mode === 'rootless'
      ? security.includes('name=rootless')
      : !security.includes('name=rootless') &&
          security.includes('name=userns') &&
          security.some((x) => x === 'name=apparmor' || x.startsWith('name=apparmor,')),
    'DOCKER_BACKEND_NOT_ENFORCED',
  );
  return digest(info);
}

export function rootlessInfo(info) {
  // Preserve the established public rejection code for this existing backend.
  try {
    return dockerInfo(info);
  } catch {
    requireThat(false, 'ROOTLESS_ISOLATION_UNAVAILABLE');
  }
}

export function verifyNamespace(proof, namespace) {
  for (const [field, start] of [
    ['uidMap', namespace.uidStart],
    ['gidMap', namespace.gidStart],
  ]) {
    const rows = proof[field]
      ?.trim()
      .split('\n')
      .map((row) => row.trim().split(/\s+/).map(Number));
    requireThat(
      rows?.length === 1 &&
        rows[0].length === 3 &&
        rows[0][0] === 0 &&
        rows[0][1] === start &&
        rows[0][2] === namespace.size,
      'CONTAINER_USER_NAMESPACE_CHANGED',
    );
  }
}
