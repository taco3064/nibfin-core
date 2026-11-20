// Invoked only by the test launcher in a fresh private mount namespace.
import assert from 'node:assert/strict';
import { cp, chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm,
  writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest, sha256 } from '../src/identity.mjs';
import { checkInstalledObservation } from './rollout-manager-observation-fixture.mjs';
import { checkAdmissionAndFootprint } from './core-rollout-admission-native-fixture.mjs';
import { checkManagementPublication } from './core-management-publication-fixture.mjs';
import { checkMaintenanceTransport } from './core-maintenance-transport-fixture.mjs';
import { checkMaintenanceInstallation }
  from './core-maintenance-installation-fixture.mjs';

const source = resolve('.');
const nodeBytes = await readFile(process.execPath);
const parentNamespace = process.argv[2];
assert.equal(process.getuid(), 0);
assert.notEqual(await readlink('/proc/self/ns/mnt'), parentNamespace,
  'Fixture must never mount over the actual host namespace');
const run = (...args) => {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
run('/usr/bin/mount', '--make-rprivate', '/');
for (const path of ['/usr/local', '/opt', '/etc']) {
  assert.ok((await lstat(path)).isDirectory());
  run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=755', 'tmpfs', path);
}
const manager = '/usr/local/libexec/nibfin/core-rollout/manager';
const live = '/opt/nibfin/core';
await mkdir(manager, { recursive: true });
await mkdir('/etc/nibfin', { recursive: true });
await mkdir('/opt/nibfin', { recursive: true });
await cp(join(source, 'src'), join(manager, 'src'), { recursive: true });
await cp(join(source, 'bin'), join(manager, 'bin'), { recursive: true });
await cp(join(source, '.node-version'), join(manager, '.node-version'));
// This is an isolated executable-byte fixture, not a claim that another Node
// version was executed. The package manifest below authenticates its test data.
const platformPath = join(manager, 'src/shared-platform.json');
const platform = JSON.parse(await readFile(platformPath, 'utf8'));
const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
platform.targets[arch].nodeSha256 = sha256(nodeBytes);
await writeFile(platformPath, JSON.stringify(platform));
const poolNode = `/opt/nibfin/tools/node-v${platform.nodeVersion}-linux-` +
  `${platform.targets[arch].artifactArch}/bin/node`;
await mkdir(resolve(poolNode, '..'), { recursive: true });
await writeFile(poolNode, nodeBytes, { mode: 0o755 });
await mkdir(join(manager, 'scripts'));
for (const file of ['host-auto-rollout.py', 'core-rollout-admin.py',
  'core_rollout_coordinator.py', 'core_rollout_result.py',
  'core-maintenance-bootstrap.mjs', 'core-maintenance-dispatch.mjs',
  'core-maintenance-bridge.py', 'core-maintenance-client.py'])
  await cp(join(source, 'scripts', file), join(manager, 'scripts', file));

async function seal(root) {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await seal(path);
    else await chmod(path, (await lstat(path)).mode & 0o111 ? 0o555 : 0o444);
  }
}
await seal(manager);

async function manifest(root, commit) {
  const files = [];
  const walk = async prefix => {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === 'nibfin-manifest.json') continue;
      if (entry.isDirectory()) await walk(path);
      else {
        const bytes = await readFile(join(root, path));
        const stat = await lstat(join(root, path));
        files.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644',
          size: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  await walk('');
  const value = { schemaVersion: 1, repository: 'taco3064/nibfin-core', commit,
    files, policyHash: digest(files.filter(file => file.path.startsWith('src/'))),
    skillsHash: digest([]) };
  await writeFile(join(root, 'nibfin-manifest.json'), JSON.stringify(value));
  return { repository: value.repository, commit, manifestHash: digest(value) };
}

const oldPin = await manifest(manager, '1'.repeat(40));
await writeFile('/usr/local/libexec/nibfin/core-rollout/source-pin.json',
  JSON.stringify(oldPin));
if (process.argv[3] === 'maintenance-installation') {
  await checkMaintenanceInstallation(manager, poolNode, manifest);
  process.exit(0);
}
if (process.argv[3] === 'maintenance-transport') {
  await checkMaintenanceTransport(manager, manifest, poolNode);
  process.exit(0);
}
if (process.argv[3] === 'maintenance-publication') {
  await checkManagementPublication(manager, oldPin, poolNode, manifest);
  process.exit(0);
}
const url = path => pathToFileURL(join(manager, 'src', path)).href;
const { admitRolloutManager } = await import(url('rollout-manager-context.mjs'));
const { applyRolloutTransaction, resumeHostApply } =
  await import(url('rollout-apply.mjs'));
const { verifyInstalledSource } = await import(url('source-package.mjs'));
const { sharedTarget } = await import(url('shared-platform.mjs'));
if (process.argv[3] === 'admission-only') {
  await checkAdmissionAndFootprint(manager, oldPin, poolNode);
  process.exit(0);
}
const runtimePath = '/usr/local/libexec/nibfin/core-rollout/runtime.json';
const expectedNode = sharedTarget(process.arch === 'x64' ? 'amd64' : 'arm64').nodePath;
const runtimeProbe = 'import runpy; m=runpy.run_path(' +
  JSON.stringify(join(manager, 'scripts/core-rollout-admin.py')) +
  '); print(m["node_path"]())';
const probe = () => spawnSync('python3', ['-B', '-c', runtimeProbe],
  { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C' } });
await writeFile(runtimePath, JSON.stringify({ nodePath: expectedNode }));
assert.equal(probe().status, 0);
await chmod(runtimePath, 0o666);
assert.notEqual(probe().status, 0, 'Writable runtime metadata must not execute');
await chmod(runtimePath, 0o644);
await writeFile(runtimePath, JSON.stringify({ nodePath: '/usr/bin/node' }));
assert.notEqual(probe().status, 0, 'Unrelated runtime path must not execute');
await rm(runtimePath);
assert.notEqual(probe().status, 0,
  'Missing runtime metadata requires normal install retry');
await writeFile(runtimePath, JSON.stringify({ nodePath: expectedNode }));
const staged = '/opt/nibfin/core-staged-' + '2'.repeat(40);
const backup = '/opt/nibfin/core-before-' + '2'.repeat(40);
const planPath = '/etc/nibfin/rollout-plan.json';

for (const interruption of [1, 2, 3, 4]) {
  for (const path of [live, staged, backup])
    await rm(path, { recursive: true, force: true });
  await cp(manager, live, { recursive: true });
  await cp(manager, staged, { recursive: true });
  const nextIdentity = join(staged, 'src/identity.mjs');
  await writeFile(nextIdentity, Buffer.concat([await readFile(nextIdentity),
    Buffer.from('\n// Next installed package fixture.\n')]));
  const newPin = await manifest(staged, '2'.repeat(40));
  const next = JSON.stringify({ repository: { runner: {
    repository: 'example/test',
  } }, installed: true }) + '\n';
  const targets = ['a', 'b'].map(name => ({ path: `/etc/nibfin/${name}.json`,
    current: '{"old":true}\n', next }));
  for (const target of targets) await writeFile(target.path, target.current);
  const plan = { schemaVersion: 2, pin: newPin, actionCommit: '3'.repeat(40),
    phase: 'applying', apply: { oldPin, targets, source: { commit: newPin.commit } } };
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile('/etc/nibfin/host.json', JSON.stringify({
    installation: { directory: live, pin: oldPin },
  }));
  const context = await admitRolloutManager();
  // The actual publisher re-enters policy immediately before a mutation.
  // A failed fresh policy check cannot rename the source or write a config.
  await assert.rejects(resumeHostApply(plan, { beforeMutation: async () => {
    throw new Error('fresh compatibility or settlement changed');
  } }), /fresh compatibility or settlement changed/);
  assert.equal(await context.installationPath(oldPin), live);
  for (const target of targets)
    assert.equal(await readFile(target.path, 'utf8'), target.current);
  const paths = { live, staged, backup };
  const writes = new Map();
  let count = 0;
  const effect = name => {
    writes.set(name, (writes.get(name) ?? 0) + 1);
    if (++count === interruption) throw new Error('fixture interruption');
  };
  const ports = {
    backup,
    package: async name => {
      try {
        const value = JSON.parse(await readFile(join(paths[name],
          'nibfin-manifest.json'), 'utf8'));
        const pin = value.commit === oldPin.commit ? oldPin : newPin;
        await verifyInstalledSource(paths[name], pin);
        return pin === oldPin ? 'old' : 'new';
      } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
    },
    move: async (from, to) => {
      await rename(paths[from], paths[to]);
      if (from === 'live') {
        assert.equal(await context.installationPath(oldPin), backup);
        // Late reads/imports must resolve wholly within the stable code closure.
        const late = await import(url('host-rollout.mjs'));
        assert.equal(typeof late.promoteHost, 'function');
      }
      effect(`${from}-${to}`);
    },
    read: path => readFile(path, 'utf8'),
    replace: async (path, bytes) => { await writeFile(path, bytes); effect(path); },
    save: value => writeFile(planPath, JSON.stringify(value)),
  };
  await assert.rejects(applyRolloutTransaction(plan, ports),
    /fixture interruption/);
  await applyRolloutTransaction(plan, ports);
  assert.ok([...writes.values()].every(value => value === 1));
  assert.equal(writes.size, 4);
  const confirmed = JSON.parse(await readFile(planPath, 'utf8'));
  await resumeHostApply(confirmed, { beforeMutation: async () => {
    throw new Error('confirmed writes must not be repeated');
  } });
  assert.equal(await context.installationPath(newPin), live);
  await assert.rejects(context.verifyInstallation({ ...newPin,
    manifestHash: 'f'.repeat(64) }),
  { code: 'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH' });
}

await checkInstalledObservation(manager, live, oldPin, manifest);

const protectedFile = join(manager, 'src/identity.mjs');
const originalBytes = await readFile(protectedFile);
const changedBytes = Buffer.concat([originalBytes, Buffer.from('\n// changed\n')]);
await writeFile(protectedFile, changedBytes);
await assert.rejects(admitRolloutManager(), { code: 'INSTALLED_SOURCE_CHANGED' });
await writeFile(protectedFile, originalBytes);
await chmod(protectedFile, 0o666);
await assert.rejects(admitRolloutManager(), { code: 'UNTRUSTED_ADOPTION_PATH' });
await chmod(protectedFile, 0o644);
process.stdout.write('Stable full closure and four interruption points passed.\n');
