import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../src/identity.mjs';
import { deliverManagedResources } from '../src/managed-resource-prepare.mjs';
import { managedProfile, managedResources as resources }
  from '../src/managed-resource-contract.mjs';
import { managedModel, managedModels } from '../src/managed-model.mjs';
import { validProviderModel } from '../src/provider-contract.mjs';
import { claudeAgentPlan, claudeVersionPattern } from '../src/claude-agent-plan.mjs';
import { createProviderBinding, installedProvider } from '../src/provider-binding.mjs';
import { adoptedProviderBinding } from '../src/shared-host-adopt.mjs';
import { fixture, image, namespace, claudeVersion } from './managed-resource-fixture.mjs';
import { providerHost } from './provider-fixture.mjs';

const claudeKind = resources.claude.kind;
const images = { agent: image('agent'), hooks: image('hooks') };
const claude = { image: image(claudeKind), version: claudeVersion };
const codexProfile = managedProfile(namespace, images);
const claudeProfile = managedProfile(namespace, images, { claude });

test('the Claude profile changes only the provider, Agent image, CLI and model', () => {
  assert.equal(digest(managedProfile(namespace, images, {})), digest(codexProfile));
  assert.equal(codexProfile.provider, undefined);
  assert.equal(codexProfile.model, managedModel);
  assert.equal(managedModel, managedModels.codex);
  assert.deepEqual(Object.keys(claudeProfile),
    ['schemaVersion', 'provider', ...Object.keys(codexProfile).slice(1)]);
  const { provider, model, isolation, secondaryIsolation, ...shared } = claudeProfile;
  assert.equal(provider, 'claude');
  assert.equal(model, 'claude-opus-5-5');
  const codexShared = { ...codexProfile };
  for (const key of ['model', 'isolation', 'secondaryIsolation'])
    delete codexShared[key];
  assert.deepEqual(shared, codexShared);
  for (const key of ['isolation', 'secondaryIsolation']) {
    const slot = claudeProfile[key];
    assert.deepEqual(slot.agent, { ...codexProfile[key].agent,
      image: claude.image, codexVersion: claudeVersion });
    assert.deepEqual(slot.hooks, codexProfile[key].hooks);
    assert(claudeVersionPattern.test(slot.agent.codexVersion));
  }
});

test('the managed Claude model passes the provider and Claude plan checks', () => {
  assert(validProviderModel(managedModels.claude));
  const content = 'Bound role instructions';
  const plan = claudeAgentPlan('deliver', { model: managedModels.claude,
    skill: { identity: 'deliver', content, hash: digest(content) },
    context: { execution: { id: '00000000-0000-4000-8000-000000000001' } },
    additionalDomains: [] });
  assert.equal(plan.args[plan.args.indexOf('--model') + 1], managedModels.claude);
});

test('a host record built from the Claude profile has a valid Claude binding', () => {
  const host = providerHost();
  // Paths are the Codex ones (pinned above); only model and isolation differ.
  host.model = claudeProfile.model;
  host.repository.isolation = structuredClone(claudeProfile.isolation);
  host.sharedRunner.additionalRunner.isolation =
    structuredClone(claudeProfile.secondaryIsolation);
  host.providerBinding = createProviderBinding(host, 'claude',
    { credentialKind: 'claude-subscription-token' });
  const binding = installedProvider(host);
  assert.equal(binding.provider, 'claude');
  assert.equal(binding.modelProfile.model, managedModels.claude);
  assert.equal(binding.components.agentImage, claude.image);
  // Until C4 lifts it, adoption still refuses the published Claude provider.
  delete host.providerBinding;
  assert.throws(() => adoptedProviderBinding(host, claudeProfile.provider),
    { code: 'CLAUDE_ADOPTION_UNAVAILABLE' });
});

test('the Claude publish never overwrites a profile Core did not compute', async () => {
  const io = fixture();
  await deliverManagedResources(io);
  io.profile = { ...io.profile, model: 'manual-model' };
  const manual = structuredClone(io.profile);
  await assert.rejects(deliverManagedResources(io, { claude: true }),
    { code: 'ENGINE_FILE_CONFLICT' });
  assert.deepEqual(io.profile, manual);
  assert(io.gateOwner);
  // A manual profile on a fresh host is refused before the Claude section.
  const fresh = fixture();
  fresh.profile = manual;
  await assert.rejects(deliverManagedResources(fresh, { claude: true }));
  assert.deepEqual(fresh.profile, manual);
});

test('an interrupted Claude publish resumes from either computed profile', async () => {
  for (const replaced of [false, true]) {
    const io = fixture();
    const publish = io.publish;
    io.publish = async (value, replaceable) => {
      if (replaceable && replaced) await publish(value, replaceable);
      if (replaceable) throw { code: 'RESOURCE_INTERRUPTED' };
      return publish(value, replaceable);
    };
    await assert.rejects(deliverManagedResources(io, { claude: true }),
      { code: 'RESOURCE_INTERRUPTED' });
    assert.equal(io.state.effects.profile, 'complete');
    assert.equal(io.state.claude.effects['profile:claude'], 'pending');
    assert.equal(io.profile.provider, replaced ? 'claude' : undefined);
    io.publish = publish;
    // The resume needs no request: the recorded Claude section is kept.
    const result = await deliverManagedResources(io);
    assert.equal(result.images.claudeAgent, claude.image);
    assert.equal(io.state.claude.effects['profile:claude'], 'complete');
    assert.equal(digest(io.profile), digest(claudeProfile));
  }
});
