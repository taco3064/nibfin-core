// Runs inside the native fixture's private mount namespace, never on host state.
import assert from 'node:assert/strict';
import { chown, chmod, mkdir, readFile, readdir, rm, writeFile }
  from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerHost } from './provider-fixture.mjs';

export async function checkInstalledObservation(manager, live, oldPin) {
  const mount = spawnSync('/usr/bin/mount',
    ['-t', 'tmpfs', '-o', 'mode=755', 'tmpfs', '/var/lib'], { encoding: 'utf8' });
  assert.equal(mount.status, 0, mount.stderr);
  const module = name => import(pathToFileURL(join(manager, 'src', name)).href);
  const { admitRolloutManager } = await module('rollout-manager-context.mjs');
  const { observeInstalledManager, verifyInstalledRollout, bindRolloutPool,
    requirePromotionSettlement } =
    await module('rollout-pool.mjs');
  const { rolloutMarker } = await module('rollout-admission.mjs');
  const { settlePoolWork } = await module('retirement-observe.mjs');
  const { withManagerAdmission } = await module('rollout-manager-admission.mjs');
  const { managedPaths, publishPrivate } = await module('managed-credential-files.mjs');
  const { poolAdmission } = await module('retirement-admission.mjs');
  const { manageCredentials, assertNoCredentialConsumers, consumeManagedCredentials } =
    await module('managed-credentials.mjs');
  const { verifyOwnedSourcePackage } = await module('owned-source-package.mjs');
  const manifest = JSON.parse(await readFile(join(live, 'nibfin-manifest.json'), 'utf8'));
  const { digest } = await module('identity.mjs');
  const newPin = { repository: manifest.repository, commit: manifest.commit,
    manifestHash: digest(manifest) };
  assert.notEqual(oldPin.commit, newPin.commit);
  for (const path of ['/etc/nibfin/rollout-plan.json',
    '/etc/nibfin/core-rollout-operation.json']) await rm(path, { force: true });
  const host = providerHost();
  Object.assign(host, { uid: 1000, gid: 1000, runnerUid: 1001, memberId: 5,
    ...managedPaths, installation: { directory: live, pin: newPin } });
  host.sharedRunner.additionalRunner.uid = 1002;
  // The secondary uses the recognized primary isolation view in this fixture.
  delete host.sharedRunner.additionalRunner.isolation;
  host.sharedRunner.runner.repository = 'taco3064/nibfin-core';
  host.sharedRunner.caller.repository = 'taco3064/nibfin-core';
  host.repository.runner = { ...host.repository.runner };
  host.repository.eventRunner = { ...host.repository.runner };
  host.sharedRunner.repositories = [1, 2, 3, 4];
  const repos = ['nibfin-core', 'nibfin-act', 'gh-nibfin', 'nibfin-e2e'];
  const names = ['host.json', 'host.nibfin-act.json',
    'host.gh-nibfin.json', 'host.nibfin-e2e.json'];
  host.wakePeerFiles = names.slice(1).map(name => '/etc/nibfin/' + name);
  for (const path of ['/var/lib/nibfin/controller', managedPaths.stateRoot,
    '/var/lib/nibfin/controller/credentials', '/var/lib/nibfin/controller/codex']) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chown(path, host.uid, host.gid);
    await chmod(path, 0o700);
  }
  for (const [index, name] of names.entries()) {
    const peer = structuredClone(host);
    peer.repository.approval = { kind: 'repository-admission-v1',
      repository: 'taco3064/' + repos[index], repositoryId: index + 1,
      memberId: host.memberId, source: {
        repository: newPin.repository, commit: newPin.commit,
        policyHash: manifest.policyHash, skillsHash: manifest.skillsHash,
      } };
    const local = { ...peer.repository.runner,
      repository: peer.repository.approval.repository, repositoryId: index + 1 };
    peer.repository.runner = local;
    peer.repository.eventRunner = { ...local };
    await writeFile('/etc/nibfin/' + name, JSON.stringify(peer) + '\n');
  }
  Object.assign(host, JSON.parse(await readFile('/etc/nibfin/host.json', 'utf8')));
  await manageCredentials(host, 'intake', { token: 'fake-fixture-token', auth: '{}' },
    { verify: async () => {}, settle: async () => {} });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === '/user')
      return Response.json({ id: 5, login: 'owner', type: 'User' });
    const index = repos.findIndex(repo => path.startsWith('/repos/taco3064/' + repo));
    assert.ok(index >= 0, path);
    if (path.endsWith('/permission'))
      return Response.json({ user: { id: 5 }, permission: 'admin' });
    return Response.json({ id: index + 1, full_name: 'taco3064/' + repos[index],
      archived: false, disabled: false });
  };
  const calls = [];
  let busy = false, nativeMismatch = false;
  const native = () => [
    { id: nativeMismatch ? 99 : 42, name: 'slot-1', status: 'online', busy },
    { id: 43, name: 'slot-2', status: 'offline', busy: false },
  ].map(runner => ({ ...runner, os: 'Linux', labels: [
    { name: 'nibfin-shared' }, { name: 'nibfin-user-5' },
  ] }));
  const ports = {
    identity: async path => calls.push('identity:' + path),
    unit: async slot => ({ ActiveState: slot === 1 ? 'active' : 'inactive' }),
    reader: () => ({ list: async () => native(), get: async () => ({
      id: 1, full_name: 'taco3064/nibfin-core',
    }) }),
    enrollments: async (reader, current, targets, pin) => {
      assert.equal(targets.length, 4);
      assert.deepEqual(pin, newPin);
      // Observe the actual managed lease throughout the native readback stage.
      await assert.rejects(assertNoCredentialConsumers(current),
        { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      for (const target of targets)
        calls.push(JSON.parse(target.next).repository.approval.repository);
    },
    workflow: async () => calls.push('workflow'),
    supervisors: async slot => assert.equal(slot, 1),
    cgroups: async (path, slots) => assert.deepEqual(slots, [2]),
    relay: async () => false,
  };
  try {
    const context = await admitRolloutManager();
    assert.deepEqual(await context.verifyInstallation(newPin), {
      repository: manifest.repository, commit: manifest.commit,
      policyHash: manifest.policyHash, skillsHash: manifest.skillsHash,
    });
    const before = await Promise.all(names.map(name =>
      readFile('/etc/nibfin/' + name, 'utf8')));
    const packagesBefore = await readdir('/opt/nibfin');
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await withManagerAdmission(context, scope =>
        observeInstalledManager(context, scope, ports));
      assert.deepEqual(result, { status: 'observed', pin: newPin });
      await assertNoCredentialConsumers(host);
    }
    assert.equal(calls.filter(call => call === 'taco3064/nibfin-e2e').length, 3);
    const binding = await bindRolloutPool(host, context, ports.identity);
    const releasePlan = { pin: newPin, binding,
      originalServices: [{ slot: 1, running: true }, { slot: 2, running: false }],
      apply: { targets: binding.adoptions.map(item => ({
        path: item.path, current: item.bytes, next: item.bytes,
      })) } };
    const readonly = () => withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, ports));
    const release = () => withManagerAdmission(context, scope =>
      verifyInstalledRollout(releasePlan, host, context, scope, ports));
    const promotion = async () => {
      const closure = '/etc/nibfin/rollout-admission.json';
      await writeFile(closure, JSON.stringify(rolloutMarker(releasePlan)) + '\n');
      try {
        await withManagerAdmission(context, scope =>
          requirePromotionSettlement(releasePlan, scope, {
            reader: ports.reader,
            settle: (current, reader, binding, options) =>
              settlePoolWork(current, reader, binding, undefined, options, {
                containers: async () => {}, jobs: async () => {},
              }),
            unit: async () => { throw new Error('service is still active'); },
            cgroups: async () => {},
          }));
      } finally { await rm(closure); }
    };
    await poolAdmission(host, async () => {
      assert.equal((await readonly()).status, 'observed');
      await assert.rejects(release(), { code: 'RETIREMENT_CONSUMER_PENDING' });
      await assert.rejects(promotion(), { code: 'RETIREMENT_CONSUMER_PENDING' });
    });
    await consumeManagedCredentials(host, async () => {
      assert.equal((await readonly()).status, 'observed');
      await assert.rejects(release(), { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      await assert.rejects(promotion(), { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
    }, { verify: async () => {} });
    const stage = join(host.stateRoot, 'stage.lock');
    await publishPrivate(stage, JSON.stringify({ pid: process.pid }), host);
    assert.equal((await readonly()).status, 'observed');
    await assert.rejects(release(), { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
    await assert.rejects(promotion(), { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
    await rm(stage);
    busy = true;
    assert.equal((await readonly()).status, 'observed');
    await assert.rejects(release(), { code: 'RETIREMENT_NATIVE_BUSY' });
    await assert.rejects(promotion(), { code: 'RETIREMENT_NATIVE_BUSY' });
    busy = false;
    const workerPorts = { ...ports, supervisors: async () => {
      throw new Error('native worker occupies service cgroup');
    } };
    await withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, workerPorts));
    await assert.rejects(withManagerAdmission(context, scope =>
      verifyInstalledRollout(releasePlan, host, context, scope, workerPorts)),
    /native worker occupies service cgroup/);
    nativeMismatch = true;
    await assert.rejects(readonly(), { code: 'RETIREMENT_NATIVE_IDENTITY_CHANGED' });
    nativeMismatch = false;
    await assertNoCredentialConsumers(host);
    assert.deepEqual(await Promise.all(names.map(name =>
      readFile('/etc/nibfin/' + name, 'utf8'))), before);
    assert.deepEqual(await readdir('/opt/nibfin'), packagesBefore);
    const files = await readdir('/etc/nibfin');
    assert.ok(!files.includes('rollout-plan.json'));
    assert.ok(!files.includes('rollout-admission.json'));
    assert.ok(!files.includes('core-rollout-operation.json'));
    const closure = '/etc/nibfin/rollout-admission.json';
    await writeFile(closure, '{"unrelated":true}\n');
    await assert.rejects(withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, ports)),
    { code: 'ROLLOUT_CLOSURE_CHANGED' });
    assert.equal(await readFile(closure, 'utf8'), '{"unrelated":true}\n');
    await rm(closure);
    await assert.rejects(withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, { ...ports,
        unit: async () => { throw new Error('native read unavailable'); } })),
    /native read unavailable/);
    await assertNoCredentialConsumers(host);
    const peer = JSON.parse(before[1]);
    peer.installation.pin = oldPin;
    await writeFile('/etc/nibfin/' + names[1], JSON.stringify(peer));
    await assert.rejects(withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, ports)),
    { code: 'MANAGED_CREDENTIAL_HOST_INVALID' });
    await writeFile('/etc/nibfin/' + names[1], before[1]);
    const installedFile = join(live, 'src/identity.mjs');
    const installedBytes = await readFile(installedFile);
    await writeFile(installedFile, Buffer.concat([installedBytes,
      Buffer.from('\n// Unapproved source change.\n')]));
    await assert.rejects(withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope, ports)),
    { code: 'INSTALLED_SOURCE_CHANGED' });
    await writeFile(installedFile, installedBytes);
    await assert.rejects(verifyOwnedSourcePackage(manager,
      { ...oldPin, manifestHash: 'f'.repeat(64) }),
    { code: 'SOURCE_MANIFEST_MISMATCH' });
  } finally { globalThis.fetch = fetchBefore; }
}
