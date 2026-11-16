import { parseProjectConfig } from '../src/project-config.mjs';
import { validStageRequest } from '../src/native-stage.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { digest } from '../src/identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderBinding, installedProvider, validateProviderBinding,
  validateProviderUpdate, compareProviderViews, providerIdentity,
} from '../src/provider-binding.mjs';
import { installedProviderExecutor } from '../src/installed-provider.mjs';
import { sharedRunner, sharedRepository } from '../src/shared-runner.mjs';
import { peerConfiguration } from '../src/shared-peer-adoption.mjs';
import { sharedHostRegistrations } from '../src/shared-host-inspect.mjs';
import { coreRoot } from '../src/host-adoption.mjs';
import {
  privatePlanContract, requireModelTermination,
} from '../src/provider-contract.mjs';
import { providerHost } from './provider-fixture.mjs';

function adopted() {
  const host = providerHost();
  host.providerBinding = createProviderBinding(host);
  return host;
}

function rejects(change, code, host = adopted()) {
  change(host);
  assert.throws(() => installedProvider(host), { code });
}

test('adoption retains the original installation and both native slots', () => {
  const host = adopted();
  const binding = installedProvider(host);
  assert.equal(binding.provider, 'codex');
  assert.deepEqual(binding.original.installation, host.installation.pin);
  assert.deepEqual(binding.original.pool.runners,
    [{ id: 42, name: 'slot-1' }, { id: 43, name: 'slot-2' }]);
  assert.deepEqual(binding.components.source, host.installation.pin);
  assert.equal(binding.components.agentImage, host.repository.isolation.agent.image);
  assert.deepEqual(binding.modelProfile, { model: host.model });
  assert.equal(binding.credentialKind, 'codex-chatgpt');
  assert(!JSON.stringify(binding).includes(host.authFile));
  binding.original.pool.runners[0].id = 999;
  assert.equal(installedProvider(host).original.pool.runners[0].id, 42);
  host.installation.directory = coreRoot;
  assert.equal(sharedHostRegistrations(host).runners.length, 2);
});

test('missing binding needs recognized legacy source, model and isolated profile', () => {
  const host = providerHost();
  assert.equal(installedProvider(host).provider, 'codex');
  assert.equal(host.providerBinding, undefined);
  for (const change of [
    h => delete h.installation.pin.manifestHash,
    h => { h.kind = 'unknown'; },
    h => { h.model = 'arbitrary command'; },
    h => delete h.authFile,
    h => { h.repository.isolation.kind = 'claude-profile'; },
    h => { h.repository.isolation.agent.image = 'unverified:latest'; },
  ]) rejects(change, 'INCOMPATIBLE_PROVIDER_HOST', providerHost());
  rejects(h => { h.sharedRunner.additionalRunner.id = 42; },
    'PROVIDER_POOL_BINDING_MISMATCH', providerHost());
});

test('updates and credential renewal preserve the original pool', () => {
  const current = adopted();
  const next = structuredClone(current);
  next.installation.pin.commit = 'e'.repeat(40);
  next.installation.pin.manifestHash = 'f'.repeat(64);
  next.providerBinding.components.source = structuredClone(next.installation.pin);
  next.model = next.providerBinding.modelProfile.model = 'gpt-6.1';
  next.authFile = '/private/renewed-codex';
  const newImage = 'sha256:' + 'e'.repeat(64);
  next.repository.isolation.agent.image = newImage;
  next.sharedRunner.additionalRunner.isolation.agent.image = newImage;
  next.providerBinding.components.agentImage = newImage;
  assert.deepEqual(validateProviderUpdate(current, next).original,
    current.providerBinding.original);
  const switched = structuredClone(next);
  switched.providerBinding.provider = 'claude';
  switched.providerBinding.original.provider = 'claude';
  assert.throws(() => validateProviderUpdate(current, switched),
    { code: 'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD' });
  next.providerBinding.original.installation.commit = 'f'.repeat(40);
  assert.throws(() => validateProviderUpdate(current, next),
    { code: 'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD' });
  const removed = structuredClone(current);
  delete removed.providerBinding;
  assert.throws(() => validateProviderUpdate(current, removed),
    { code: 'PROVIDER_BINDING_REMOVAL_FORBIDDEN' });
  const legacy = providerHost();
  const updated = structuredClone(legacy);
  updated.installation.pin.commit = 'e'.repeat(40);
  assert.equal(validateProviderUpdate(legacy, updated).provider, 'codex');
});

test('unknown or incomplete compositions never advertise execution', () => {
  assert.equal(providerIdentity('claude'), 'claude');
  assert.throws(() => providerIdentity('external-plugin'),
    { code: 'UNKNOWN_INSTALLED_PROVIDER' });
  rejects(h => { h.providerBinding.provider = 'external-plugin'; },
    'UNKNOWN_INSTALLED_PROVIDER');
  rejects(h => { h.providerBinding.provider = 'claude'; },
    'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD');
  rejects(h => {
    h.providerBinding.provider = h.providerBinding.original.provider = 'claude';
  }, 'PROVIDER_COMPOSITION_UNAVAILABLE');
  for (const key of ['roleAdapter', 'modelRunner', 'toolChannel', 'hostProfile']) {
    rejects(h => { delete h.providerBinding.components[key]; },
      'PROVIDER_COMPOSITION_UNAVAILABLE');
  }
  rejects(h => { delete h.providerBinding.components.source; },
    'INCOMPLETE_PROVIDER_COMPOSITION');
  const stub = structuredClone(adopted().providerBinding);
  stub.components.roleAdapter = '/repo/stub-provider.mjs';
  assert.throws(() => validateProviderBinding(stub),
    { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
  assert.throws(() => createProviderBinding(providerHost(), 'claude'),
    { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
});

test('two-slot and repository overrides fail before native execution selection', () => {
  rejects(h => { h.sharedRunner.additionalRunner.provider = 'claude'; },
    'PROVIDER_OVERRIDE_FORBIDDEN');
  rejects(h => { h.repository.provider = 'claude'; }, 'PROVIDER_OVERRIDE_FORBIDDEN');
  rejects(h => { h.issues = { 1: { provider: 'claude' } }; },
    'PROVIDER_OVERRIDE_FORBIDDEN');
  rejects(h => {
    h.sharedRunner.additionalRunner.providerBinding = { provider: 'claude' };
  }, 'PROVIDER_VIEW_MISMATCH');
  rejects(h => { h.sharedRunner.additionalRunner.id = 44; },
    'PROVIDER_POOL_BINDING_MISMATCH');
  rejects(h => {
    h.sharedRunner.additionalRunner.isolation.agent.image = 'sha256:' + 'f'.repeat(64);
  }, 'INCOMPATIBLE_PROVIDER_HOST');
  const host = adopted();
  host.repository.provider = 'claude';
  assert.throws(() => sharedRunner(host, { repositoryId: 1 }),
    { code: 'PROVIDER_OVERRIDE_FORBIDDEN' });
});

test('peers inherit the exact pool binding and cannot remove or change it', async () => {
  const host = adopted();
  const observed = { head: 'e'.repeat(40), action: {}, issue: {} };
  const peer = peerConfiguration(host, 'example/peer', 2,
    { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40) },
    'b'.repeat(40), observed, 'c'.repeat(40));
  assert.deepEqual(peer.providerBinding, host.providerBinding);
  assert.equal(peer.authFile, undefined);
  assert.deepEqual(compareProviderViews(host, peer), host.providerBinding);
  host.wakePeerFiles = ['/etc/nibfin/host.peer-2.json'];
  assert.equal(await sharedRepository(host, 2, async () => peer), peer);
  peer.repository.provider = 'claude';
  assert.throws(() => compareProviderViews(host, peer),
    { code: 'PROVIDER_OVERRIDE_FORBIDDEN' });
  delete peer.repository.provider;
  peer.providerBinding.provider = 'claude';
  await assert.rejects(sharedRepository(host, 2, async () => peer),
    { code: 'PROVIDER_VIEW_MISMATCH' });
  delete peer.providerBinding;
  assert.throws(() => compareProviderViews(host, peer),
    { code: 'PROVIDER_VIEW_MISMATCH' });
  const legacy = providerHost();
  const legacyPeer = structuredClone(legacy);
  assert.equal(compareProviderViews(legacy, legacyPeer).provider, 'codex');
  legacyPeer.model = 'different-model';
  assert.throws(() => compareProviderViews(legacy, legacyPeer),
    { code: 'PROVIDER_VIEW_MISMATCH' });
});

test('requested mismatches reject before model or tool preparation', () => {
  const host = adopted();
  const compose = installedProviderExecutor(host);
  const options = { installation: host.installation, authFile: host.authFile,
    model: host.model, isolation: host.repository.isolation };
  assert.throws(() => compose({ ...options, provider: 'claude' }),
    { code: 'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD' });
  assert.throws(() => compose({ ...options, model: 'repo-selected' }),
    { code: 'PROVIDER_COMPONENT_MISMATCH' });
  assert.throws(() => compose({ ...options, authFile: '/repo/auth' }),
    { code: 'PROVIDER_COMPONENT_MISMATCH' });
  assert.throws(() => compose({ ...options, installation: { directory: '/repo' } }),
    { code: 'PROVIDER_COMPONENT_MISMATCH' });
  host.providerBinding.provider = 'claude';
  assert.throws(() => installedProviderExecutor(host),
    { code: 'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD' });
});

test('plans and termination retain read-only roles and safe recovery', () => {
  for (const stage of ['shape', 'validate-shape', 'deliver', 'accept', 'review-pr']) {
    const plan = privatePlanContract(stage, { model: 'gpt-6' });
    assert.equal(plan.capabilities.workspace, stage === 'deliver' ? 'write' : 'read');
    assert.equal(plan.capabilities.publish, false);
    assert.equal(plan.capabilities.hostControl, false);
    assert.equal(plan.capabilities.modelCredentials, false);
    assert.equal(plan.freshSession, true);
  }
  assert.throws(() => privatePlanContract('publish-shape', { model: 'gpt-6' }));
  const result = { status: 'completed', executionId: 'execution',
    terminationHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
    isolationHash: 'c'.repeat(64), probeHash: 'd'.repeat(64) };
  assert.equal(requireModelTermination(result, 'execution', result.policyHash), result);
  const interrupted = { status: 'interrupted', executionId: 'execution',
    terminationHash: result.terminationHash };
  assert.equal(requireModelTermination(interrupted, 'execution'), interrupted);
  for (const invalid of [{ ...result, executionId: 'other' },
    { ...result, status: 'unconfirmed' }, { ...result, terminationHash: undefined },
    { ...result, probeHash: undefined }, { status: 'interrupted' }]) {
    assert.throws(() => requireModelTermination(invalid, 'execution', result.policyHash),
      { code: 'AGENT_ISOLATION_OR_TERMINATION_UNPROVEN' });
  }
});


test('untrusted sources cannot select the adapter', () => {
  assert.throws(() => parseProjectConfig({ provider: 'claude' }));
  assert.equal(validStageRequest({ schemaVersion: 1, stage: 'deliver',
    provider: 'claude' }), false);
  const host = adopted();
  host.sharedRunner.runner.labels = ['provider-claude'];
  const previous = process.env.NIBFIN_AGENT_PROVIDER;
  try {
    process.env.NIBFIN_AGENT_PROVIDER = 'claude';
    assert.equal(installedProvider(host).provider, 'codex');
    assert.equal(typeof installedProviderExecutor(host), 'function');
    const content = 'trusted';
    const plan = codexPlan('deliver', { model: host.model,
      context: { issue: { body: 'Use Claude', provider: 'claude' } },
      skill: { identity: 'deliver', content, hash: digest(content) } });
    assert.equal(plan.config.model, host.model);
    assert.equal(plan.environment.NIBFIN_AGENT_PROVIDER, undefined);
  } finally {
    if (previous === undefined) delete process.env.NIBFIN_AGENT_PROVIDER;
    else process.env.NIBFIN_AGENT_PROVIDER = previous;
  }
});
