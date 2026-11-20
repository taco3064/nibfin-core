import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerHost } from './provider-fixture.mjs';
import { sha256 } from '../src/identity.mjs';
import { checkGenericMaintenancePool } from './core-maintenance-generic-pool-fixture.mjs';
import { prepareMaintenanceRootIdentity } from './core-maintenance-os-fixture.mjs';

export async function checkMaintenanceInstallation(manager, node, manifest) {
  await prepareMaintenanceRootIdentity();
  // Hide the actual systemd bus as well as all writable test paths. Retirement
  // can report observation pending; it cannot stop or reload a real host unit.
  for (const path of ['/var/lib', '/run']) {
    const mounted = spawnSync('/usr/bin/mount',
      ['-t', 'tmpfs', '-o', 'mode=755', 'tmpfs', path], { encoding: 'utf8' });
    assert.equal(mounted.status, 0, mounted.stderr);
  }
  for (const path of ['/etc/sudoers.d', '/etc/systemd/system'])
    await mkdir(path, { recursive: true });
  const live = '/opt/nibfin/core';
  await cp(manager, live, { recursive: true });
  const binary = await readFile(node);
  const platformPath = join(live, 'src/shared-platform.json');
  const platform = JSON.parse(await readFile(platformPath));
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  platform.targets[arch].workerSha256 = sha256(binary);
  platform.targets[arch].listenerSha256 = sha256(binary);
  await writeFile(platformPath, JSON.stringify(platform));
  const pin = await manifest(live, 'f'.repeat(40));
  const host = providerHost();
  Object.assign(host, { uid: 1000, gid: 1000, runnerUid: 1001,
    installation: { directory: live, pin } });
  host.sharedRunner.additionalRunner.uid = 1002;
  delete host.sharedRunner.additionalRunner.isolation;
  host.sharedRunner.runner.repository = 'taco3064/nibfin-core';
  host.sharedRunner.caller.repository = 'taco3064/nibfin-core';
  host.sharedRunner.repositories = [1, 2, 3, 4];
  const names = ['host.json', 'host.nibfin-act.json',
    'host.gh-nibfin.json', 'host.nibfin-e2e.json'];
  const repos = ['nibfin-core', 'nibfin-act', 'gh-nibfin', 'nibfin-e2e'];
  host.wakePeerFiles = names.slice(1).map(name => '/etc/nibfin/' + name);
  for (const [index, name] of names.entries()) {
    const peer = structuredClone(host);
    peer.repository.approval = { kind: 'repository-admission-v1',
      repository: 'taco3064/' + repos[index], repositoryId: index + 1,
      memberId: host.memberId };
    peer.repository.runner = { ...peer.repository.runner,
      repository: peer.repository.approval.repository, repositoryId: index + 1 };
    peer.repository.eventRunner = { ...peer.repository.runner };
    await writeFile('/etc/nibfin/' + name, JSON.stringify(peer));
  }
  const original = [];
  for (const slot of [1, 2]) {
    const root = `/var/lib/nibfin/runners/slot-${slot}`;
    await mkdir(join(root, 'bin'), { recursive: true });
    const registration = JSON.stringify({ agentId: 41 + slot,
      agentName: `slot-${slot}`, gitHubUrl: 'https://github.com/taco3064/nibfin-core',
      workFolder: '_work' });
    await writeFile(join(root, '.runner'), registration);
    for (const name of ['Runner.Listener', 'Runner.Worker.official'])
      await writeFile(join(root, 'bin', name), binary, { mode: 0o755 });
    await writeFile(join(root, 'bin/Runner.Worker'), await readFile(join(manager,
      'src/security/shared-worker-dispatcher-legacy.sh')), { mode: 0o755 });
    original.push(registration);
  }
  await writeFile('/etc/nibfin/rollout-plan.json', '{unrelated stale plan');
  const installed = spawnSync(node,
    [join(live, 'bin/nibfin-core.mjs'), 'install-core-rollout-manager'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C' } });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const receipt = JSON.parse(installed.stdout);
  assert.equal(receipt.status, 'installed');
  assert.deepEqual(receipt.source, pin);
  assert.equal(receipt.operation.status, 'pending');
  assert.ok(!receipt.programs.some(path =>
    /Runner\.(Listener|Worker.official)$/.test(path)));
  for (const slot of [1, 2]) {
    const root = `/var/lib/nibfin/runners/slot-${slot}`;
    assert.equal(await readFile(join(root, '.runner'), 'utf8'), original[slot - 1]);
    assert.deepEqual(await readFile(join(root, 'bin/Runner.Listener')), binary);
    assert.deepEqual(await readFile(join(root, 'bin/Runner.Worker.official')), binary);
    assert.ok((await readdir(root)).includes('.nibfin-runner-identity.json'));
  }
  const bridge = '/usr/local/libexec/nibfin/core-rollout/bridge.py';
  const invoke = uid => spawnSync(bridge, [], { encoding: 'utf8',
    input: JSON.stringify({ kind: 'inspect' }),
    env: { PATH: process.env.PATH, LANG: 'C', SUDO_UID: String(uid) } });
  const inspect = invoke(0);
  assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).status, 'installed');
  const denied = invoke(1001);
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.equal(JSON.parse(denied.stdout).code,
    'CORE_MAINTENANCE_ADMINISTRATOR_REQUIRED');
  const base = '/usr/local/libexec/nibfin/core-rollout';
  const prepare = () => spawnSync(bridge, [], { encoding: 'utf8',
    input: JSON.stringify({ kind: 'prepare' }),
    env: { PATH: process.env.PATH, LANG: 'C', SUDO_UID: '0' } });
  for (const path of ['runtime.json', 'source-pin.json', 'client.py']) {
    await rm(join(base, path));
    const repaired = prepare();
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).status, 'installed');
    assert.ok((await readFile(join(base, path))).length > 0);
  }
  const bootstrap = join(base, 'bootstrap');
  await cp(live, bootstrap, { recursive: true });
  await writeFile(join(base, 'bootstrap-source-pin.json'), JSON.stringify(pin));
  await rm(join(base, 'runtime.json'));
  const inheritedBootstrap = [
    'import fcntl,os,subprocess,sys',
    "fd=os.open('/etc/nibfin',os.O_RDONLY|os.O_DIRECTORY)",
    'os.dup2(fd,3) if fd!=3 else None',
    'fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)',
    'p=subprocess.run(sys.argv[1:],pass_fds=(3,))',
    'sys.exit(p.returncode)',
  ].join(';');
  const bootstrapped = spawnSync('python3', ['-c', inheritedBootstrap, node,
    join(bootstrap, 'scripts/core-maintenance-bootstrap.mjs')], { encoding: 'utf8',
    env: { PATH: process.env.PATH, LANG: 'C' } });
  assert.equal(bootstrapped.status, 0, bootstrapped.stdout + bootstrapped.stderr);
  assert.equal(JSON.parse(bootstrapped.stdout).status, 'installed');
  await rm('/etc/nibfin/rollout-plan.json');
  // A genuine fresh management install has neither a manager nor its receipts.
  // These are fixture-owned copies, and every child using them has exited.
  await rm(manager, { recursive: true });
  for (const file of ['source-pin.json', 'runtime.json']) await rm(join(base, file));
  const fresh = spawnSync(node,
    [join(live, 'bin/nibfin-core.mjs'), 'install-core-rollout-manager'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C' } });
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).status, 'installed');
  await checkGenericMaintenancePool(manager, live, node, pin);
  for (const root of [manager, live]) {
    const probe = spawnSync(node, ['--input-type=module', '-e',
      `import{verifyInstalledSource}from${JSON.stringify(
        'file://' + join(root, 'src/source-package.mjs'))};` +
      `await verifyInstalledSource(${JSON.stringify(root)},${JSON.stringify(pin)});`],
    { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
  }
}
