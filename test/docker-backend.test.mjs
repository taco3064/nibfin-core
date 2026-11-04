import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dockerBackend,
  dockerInfo,
  verifyDockerSocket,
  verifyNamespace,
  rootfulSocket,
  validDockerEndpoint,
} from '../src/docker-backend.mjs';

const namespace = { uidStart: 231072, gidStart: 231072, size: 65536 };
const backend = dockerBackend({ kind: 'linux-rootful-docker-v1', namespace });
const info = {
  SecurityOptions: [
    'name=userns',
    'name=apparmor,profile=default',
    'name=seccomp,profile=builtin',
  ],
  CgroupVersion: '2',
  CgroupDriver: 'systemd',
  MemoryLimit: true,
  PidsLimit: true,
  CpuCfsPeriod: true,
  CpuCfsQuota: true,
};

test('rootful is explicit, remapped, enforcing and resource bounded', () => {
  assert.match(dockerInfo(info, backend), /^[a-f0-9]{64}$/);
  assert.throws(() => dockerInfo(info), /DOCKER_BACKEND_NOT_ENFORCED/);
  for (const feature of info.SecurityOptions) {
    const changed = structuredClone(info);
    changed.SecurityOptions = changed.SecurityOptions.filter((x) => x !== feature);
    assert.throws(() => dockerInfo(changed, backend));
  }
  for (const key of ['MemoryLimit', 'PidsLimit', 'CpuCfsPeriod', 'CpuCfsQuota']) {
    assert.throws(() => dockerInfo({ ...info, [key]: false }, backend));
  }
  assert.throws(() => dockerBackend({ kind: 'linux-rootful-docker-v1' }));
  assert.throws(() => dockerBackend({ kind: 'user-module' }));
  assert.throws(() =>
    dockerBackend({ kind: backend.kind, namespace: { ...namespace, uidStart: 0 } }),
  );
});

test('kernel maps root and tools into the adopted subordinate range', () => {
  const proof = { uidMap: '0 231072 65536\n', gidMap: '0 231072 65536\n' };
  verifyNamespace(proof, namespace);
  for (const map of [
    '0 0 4294967295',
    '1000 232072 1',
    '0 231072 1000',
    '0 231072 65536\n65536 0 1',
    '0 296608 65536',
    'invalid',
  ]) {
    for (const field of ['uidMap', 'gidMap']) {
      assert.throws(
        () => verifyNamespace({ ...proof, [field]: map }, namespace),
        /CONTAINER_USER_NAMESPACE_CHANGED/,
      );
    }
  }
});

test('only the private root-owned socket and controller group are accepted', async () => {
  const stat = { uid: 0, gid: 986, mode: 0o660, isSocket: () => true };
  const host = {
    platform: 'linux',
    uid: 999,
    gids: [986],
    realpath: async (p) => p,
    lstat: async () => stat,
    rootOwnedPath: async (p) =>
      assert.ok(['/run/nibfin-engine', '/usr/bin/docker'].includes(p)),
  };
  await verifyDockerSocket(rootfulSocket, backend, host);
  assert.equal(
    validDockerEndpoint({ docker: '/tmp/docker', socket: rootfulSocket }, backend),
    false,
  );
  for (const changed of [{ uid: 0 }, { uid: 70000 }, { gids: [] }]) {
    await assert.rejects(
      verifyDockerSocket(rootfulSocket, backend, { ...host, ...changed }),
    );
  }
  for (const changed of [{ uid: 999 }, { gid: 0 }, { mode: 0o666 }]) {
    await assert.rejects(
      verifyDockerSocket(rootfulSocket, backend, {
        ...host,
        lstat: async () => ({ ...stat, ...changed }),
      }),
    );
  }
  await assert.rejects(verifyDockerSocket('/var/run/docker.sock', backend, host));
  await assert.rejects(
    verifyDockerSocket(rootfulSocket, backend, {
      ...host,
      rootOwnedPath: async () => {
        throw new Error('Writable parent');
      },
    }),
  );
});
