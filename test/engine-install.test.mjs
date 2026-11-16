import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { deliverEngine } from '../src/engine-install.mjs';
import { engineAdmission, requireEngineAdministrator } from '../src/engine-host.mjs';
import { engine } from '../src/engine-contract.mjs';
import { engineFixture } from './engine-fixture.mjs';

const rejected = (promise, code) => assert.rejects(promise, { code });

test('managed installation settles stock activation, verifies maps and reuses resources',
  async () => {
    const io = engineFixture();
    const descriptor = await deliverEngine(io);
    assert.equal(descriptor.socket, engine.socket);
    assert.deepEqual(descriptor.namespace,
      { size: 65536, uidStart: 65536, gidStart: 65536 });
    assert.deepEqual(io.commands, [
      'mask docker.socket', 'stop docker.socket',
      'mask docker.service', 'stop docker.service', 'daemon-reload',
      'enable nibfin-engine.service', 'start nibfin-engine.service',
    ]);
    assert.equal(io.state.stock['docker.service'].ActiveState, 'active');
    const initial = structuredClone(io.commands);
    assert.deepEqual(await deliverEngine(io), descriptor);
    assert.deepEqual(io.commands, initial);
    assert.deepEqual(io.probeResources, { image: null, container: null });
  });

test('workloads, overrides and unrelated configuration refuse handoff', async () => {
  for (const [options, code] of [
    [{ workloads: true }, 'ENGINE_STOCK_WORKLOADS'],
    [{ override: 'docker.service' }, 'ENGINE_STOCK_CUSTOM_CONFIGURATION'],
    [{ override: 'docker.socket' }, 'ENGINE_STOCK_CUSTOM_CONFIGURATION'],
    [{ custom: true }, 'ENGINE_STOCK_CUSTOM_CONFIGURATION'],
  ]) {
    const io = engineFixture(options);
    await rejected(deliverEngine(io), code);
    assert.deepEqual(io.commands, []);
  }
});

test('uncertain stock effects retain intent without advancing or retrying', async () => {
  for (const transition of ['mask:docker.socket', 'stop:docker.socket',
    'mask:docker.service', 'stop:docker.service']) {
    const io = engineFixture({ uncertain: transition });
    await rejected(deliverEngine(io), 'ENGINE_STOCK_RECONCILIATION_REQUIRED');
    const commands = structuredClone(io.commands);
    assert.equal(io.state.effects[transition], 'pending');
    await rejected(deliverEngine(io), 'ENGINE_STOCK_RECONCILIATION_REQUIRED');
    assert.deepEqual(io.commands, commands);
    assert(!commands.includes('start nibfin-engine.service'));
  }
});

test('lost stock and start responses reconcile from actual effective state', async () => {
  for (const responseLost of ['stop:docker.service', 'mask:docker.socket',
    'start:nibfin-engine.service']) {
    const io = engineFixture({ responseLost });
    assert.equal((await deliverEngine(io)).socket, engine.socket);
  }
});

test('uncertain managed start retains intent without a second start', async () => {
  const io = engineFixture({ uncertain: 'start:nibfin-engine.service' });
  await rejected(deliverEngine(io), 'ENGINE_START_RECONCILIATION_REQUIRED');
  await rejected(deliverEngine(io), 'ENGINE_START_RECONCILIATION_REQUIRED');
  const starts = io.commands.filter(row => row === 'start nibfin-engine.service');
  assert.equal(starts.length, 1);
  assert.equal(io.units['docker.socket'].LoadState, 'masked');
});

test('unsafe access and incorrect kernel maps cannot produce a descriptor', async () => {
  const unsafe = engineFixture({ unsafeAccess: true });
  await rejected(deliverEngine(unsafe), 'RUNNER_DOCKER_ACCESS_FORBIDDEN');
  assert(!unsafe.commands.includes('start nibfin-engine.service'));
  const maps = engineFixture({ badMap: true });
  await rejected(deliverEngine(maps), 'CONTAINER_USER_NAMESPACE_CHANGED');
  assert.deepEqual(maps.probeResources, { image: null, container: null });
});

test('changed installed resources are refused on repeat invocation', async () => {
  const io = engineFixture();
  await deliverEngine(io);
  io.files.set(engine.config, 'unrelated');
  await rejected(deliverEngine(io), 'ENGINE_FILE_CONFLICT');
  assert.equal(io.files.get(engine.config), 'unrelated');
});

test('the real entry refuses a non-installed source before host mutation', async () => {
  const linux = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);
  const code = linux &&
    process.getuid() === 0 ? 'ENGINE_REQUIRES_INSTALLED_CORE' :
    'ENGINE_REQUIRES_SUPPORTED_LINUX_ADMINISTRATOR';
  await rejected(engineAdmission(true), code);
  if (linux && process.getuid() === 0)
    await rejected(engineAdmission(false),
      'ENGINE_DEDICATED_HOST_ACKNOWLEDGEMENT_REQUIRED');
});

test('administrator admission rejects unsupported platforms and missing consent', () => {
  for (const [platform, arch, uid] of [['darwin', 'x64', 0],
    ['linux', 'riscv64', 0], ['linux', 'x64', 1000]]) {
    assert.throws(() => requireEngineAdministrator(platform, arch, uid, true),
      { code: 'ENGINE_REQUIRES_SUPPORTED_LINUX_ADMINISTRATOR' });
  }
  assert.throws(() => requireEngineAdministrator('linux', 'x64', 0, false),
    { code: 'ENGINE_DEDICATED_HOST_ACKNOWLEDGEMENT_REQUIRED' });
  requireEngineAdministrator('linux', 'x64', 0, true);
  requireEngineAdministrator('linux', 'arm64', 0, true);
});

test('the fixed executable denies overrides and a non-installed source', () => {
  const entry = 'bin/nibfin-engine-install.mjs';
  for (const args of [[], ['--socket=/tmp/docker.sock'],
    ['--dedicated-disposable-host', '--acknowledge-stock-handoff', '/tmp/config']]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code,
      'ENGINE_DEDICATED_HOST_ACKNOWLEDGEMENT_REQUIRED');
  }
  const result = spawnSync(process.execPath, [entry,
    '--dedicated-disposable-host', '--acknowledge-stock-handoff'],
  { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).code,
    /^ENGINE_REQUIRES_(INSTALLED_CORE|SUPPORTED_LINUX_ADMINISTRATOR)$/);
});
