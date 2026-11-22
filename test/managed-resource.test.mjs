import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { deliverManagedResources } from '../src/managed-resource-prepare.mjs';
import { managedProfile } from '../src/managed-resource-contract.mjs';
import { consumerContract } from '../src/public-api.mjs';
import { requireResourcesSettled, resourcePreparationGate }
  from '../src/managed-resource-admission.mjs';
import { verifyPreparationResult } from '../src/managed-resource-smoke.mjs';
import { fixture, image, namespace } from './managed-resource-fixture.mjs';

test('credential-free preparation checks four configurations and repeats fresh probes',
  async () => {
    const io = fixture();
    const first = verifyPreparationResult(await deliverManagedResources(io));
    assert.equal(io.proofs, 4);
    assert.equal(io.gateOwner, null);
    assert.deepEqual(await deliverManagedResources(io), first);
    assert.equal(io.proofs, 8);
    const profile = managedProfile(namespace, first.images);
    assert.notEqual(profile.isolation.agent.mcpPolicyDirectory,
      profile.secondaryIsolation.agent.mcpPolicyDirectory);
    assert.equal(profile.authFile, '/var/lib/nibfin/controller/codex/auth.json');
    assert.equal(first.adoption, false);
    assert.equal(first.servicesReady, false);
  });

test('second slot isolation failure prevents publication and still removes its probe',
  async () => {
    const io = fixture('second-slot');
    await assert.rejects(deliverManagedResources(io),
      { code: 'CONTAINER_USER_NAMESPACE_CHANGED' });
    assert.equal(io.state.effects.profile, undefined);
    assert.equal(io.state.probe.phase, 'complete');
    assert(io.gateOwner);
  });

test('unknown creates and cleanup retain intent and prohibit blind retry', async () => {
  for (const fault of ['create-unknown', 'cleanup-unknown',
    'termination-unknown', 'process-unknown']) {
    const io = fixture(fault);
    await assert.rejects(deliverManagedResources(io));
    const before = io.commands.length;
    await assert.rejects(deliverManagedResources(io),
      { code: 'RESOURCE_PROBE_RECONCILIATION_REQUIRED' });
    assert.equal(io.commands.length, before);
    assert(io.gateOwner);
    assert.equal(io.state.effects.profile, undefined);
  }
});

test('image drift and manual profile conflicts prevent a prepared result', async () => {
  const drift = fixture();
  await deliverManagedResources(drift);
  drift.images.agent = image('hooks');
  await assert.rejects(deliverManagedResources(drift), { code: 'RESOURCE_IMAGE_DRIFT' });
  const conflict = fixture('profile-conflict');
  await assert.rejects(deliverManagedResources(conflict),
    { code: 'ENGINE_FILE_CONFLICT' });
  assert(conflict.gateOwner);
});

test('public capability and administrator entry accept no resource selection', () => {
  assert.deepEqual(consumerContract.managedResourcePreparation.arguments,
    ['--consent-resource-preparation']);
  for (const args of [[], ['--profile=/tmp/profile'],
    ['--consent-resource-preparation', '--socket=/tmp/docker.sock']]) {
    const result = spawnSync(process.execPath,
      ['bin/nibfin-prepare-shared-host.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'RESOURCE_PREPARATION_CONSENT_REQUIRED');
  }
  const result = spawnSync(process.execPath,
    ['bin/nibfin-prepare-shared-host.mjs', '--consent-resource-preparation'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const administrator = process.platform === 'linux' &&
    ['x64', 'arm64'].includes(process.arch) &&
    process.getuid?.() === 0;
  const expected = administrator ? 'ENGINE_REQUIRES_INSTALLED_CORE'
    : 'ENGINE_REQUIRES_SUPPORTED_LINUX_ADMINISTRATOR';
  assert.equal(JSON.parse(result.stdout).code, expected);
});

test('egress replacement and package changes are rejected on retry', async () => {
  const io = fixture();
  await deliverManagedResources(io);
  io.egress = async () => 'e'.repeat(64);
  await assert.rejects(deliverManagedResources(io), { code: 'RESOURCE_NETWORK_DRIFT' });
  io.inputs = async () => ({ policy: 'changed' });
  await assert.rejects(deliverManagedResources(io), { code: 'RESOURCE_STATE_CONFLICT' });
});

test('policy drift during probes prevents final profile publication', async () => {
  const io = fixture();
  let observations = 0;
  io.policy = async () => {
    if (++observations === 2) throw { code: 'RESOURCE_POLICY_RECONCILIATION_REQUIRED' };
  };
  await assert.rejects(deliverManagedResources(io),
    { code: 'RESOURCE_POLICY_RECONCILIATION_REQUIRED' });
  assert.equal(io.state.effects.profile, undefined);
  assert(io.gateOwner);
});

test('unresolved preparation blocks admission without private state', async () => {
  await assert.rejects(requireResourcesSettled(async path => {
    assert.equal(path, resourcePreparationGate);
    return {};
  }), { code: 'RESOURCE_PREPARATION_RECONCILIATION_REQUIRED' });
  await requireResourcesSettled(async () => { throw { code: 'ENOENT' }; });
  await assert.rejects(requireResourcesSettled(async () => { throw { code: 'EACCES' }; }),
    { code: 'EACCES' });
});

test('native availability failure prevents publication and proves probe cleanup',
  async () => {
    const io = fixture('native-unavailable');
    await assert.rejects(deliverManagedResources(io),
      { code: 'RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE' });
    assert.equal(io.state.effects.profile, undefined);
    assert.equal(io.state.probe.phase, 'complete');
    assert(io.gateOwner);
    assert(io.commands.some(args => args[0] === 'rm'));
  });

test('platform-specific inputs cannot reuse another target recovery state', async () => {
  const io = fixture();
  let architecture = 'arm64';
  io.verifyEngine = async () => ({ identity: 'engine', namespace, architecture });
  io.inputs = async target => ({ policy: 'policy', native: { platform: target } });
  await deliverManagedResources(io);
  assert.equal(io.state.architecture, 'arm64');
  architecture = 'amd64';
  const before = io.commands.length;
  await assert.rejects(deliverManagedResources(io), { code: 'RESOURCE_STATE_CONFLICT' });
  assert.equal(io.commands.length, before);
});

test('unavailable native inputs stop before journal, gate or managed effects',
  async () => {
    const io = fixture();
    io.inputs = async () => { throw { code: 'RESOURCE_INPUT_IMAGE_UNAVAILABLE' }; };
    io.load = async () => { assert.fail('must resolve inputs before recovery'); };
    await assert.rejects(deliverManagedResources(io),
      { code: 'RESOURCE_INPUT_IMAGE_UNAVAILABLE' });
    assert.equal(io.state, null);
    assert.equal(io.gateOwner, null);
    assert.equal(io.commands.length, 0);
  });
