import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './identity.mjs';
import {
  managedProfile, preparedResult, managedResources, policyTargets,
} from './managed-resource-contract.mjs';
import { resourceProbe } from './managed-resource-probe.mjs';

const claude = managedResources.claude;
const claudeProfileEffect = 'profile:claude';

// Only the Claude-specific inputs; the Codex digest in `state.inputs` never moves.
function claudeDigest(inputs) {
  const names = [claude.recipe, claude.package, claude.shell, claude.profileFile];
  const version = inputs.versions?.claude;
  requireThat(typeof version === 'string' &&
    names.every(name => typeof inputs[name] === 'string'),
  'RESOURCE_INPUT_CONTRACT_INVALID');
  return digest({ recipe: inputs[claude.recipe], package: inputs[claude.package],
    shell: inputs[claude.shell], profile: inputs[claude.profileFile], version });
}

// Like the Codex journal, the Claude section is created only on a pristine
// Claude host and never follows changed Claude inputs.
async function admitClaude(io, state, inputs) {
  const claudeInputs = claudeDigest(inputs);
  if (!state.claude) {
    await io.claudePristine();
    const previous = structuredClone(state);
    state.claude = { inputs: claudeInputs, effects: {}, images: {} };
    await io.save(state, previous);
  }
  requireThat(state.claude.inputs === claudeInputs && state.claude.effects &&
    state.claude.images, 'RESOURCE_STATE_CONFLICT');
}

// Pure orchestration; only the installed entry constructs privileged capabilities.
// A Claude request adds its own journal section after the unchanged Codex steps.
// Once that section exists, every later run keeps Claude: it never reverts the host.
export async function deliverManagedResources(io, { claude: requested = false } = {}) {
  const engine = await io.verifyEngine();
  const architecture = engine.architecture ?? 'amd64';
  const inputs = await io.inputs(architecture);
  const claudeRead = () => io.inputs(architecture, { claude: true });
  let claudeInputs = requested ? await claudeRead() : null;
  let state = await io.load();
  if (!state) {
    await io.pristine();
    state = { version: 1, owner: randomUUID(), inputs: digest(inputs), architecture,
      engine: engine.identity, effects: {}, images: {} };
    await io.save(state, null);
  }
  requireThat(state.version === 1 && /^[a-f0-9-]{36}$/.test(state.owner) &&
    state.inputs === digest(inputs) && state.engine === engine.identity &&
    (state.architecture ?? 'amd64') === architecture &&
    state.images && state.effects, 'RESOURCE_STATE_CONFLICT');
  requireThat(!state.probe || state.probe.phase === 'complete',
    'RESOURCE_PROBE_RECONCILIATION_REQUIRED');
  if (!claudeInputs && state.claude) claudeInputs = await claudeRead();
  if (claudeInputs) await admitClaude(io, state, claudeInputs);
  await io.gate(state.owner);
  let saved = structuredClone(state);
  const save = async () => {
    await io.save(state, saved);
    saved = structuredClone(state);
  };
  const effect = async (key, action, effects = state.effects) => {
    const previous = effects[key];
    requireThat(previous === undefined || ['pending', 'complete'].includes(previous),
      'RESOURCE_STATE_CONFLICT');
    if (!previous) {
      effects[key] = 'pending';
      await save();
    }
    await action(previous !== undefined);
    effects[key] = 'complete';
    await save();
  };
  const image = (kind, kindInputs, { images, effects } = state) =>
    effect(`image:${kind}`, async observe => {
      const id = await io.image(kind, state, kindInputs, observe);
      requireThat(/^sha256:[a-f0-9]{64}$/.test(id) &&
        (!images[kind] || images[kind] === id), 'RESOURCE_IMAGE_DRIFT');
      images[kind] = id;
    }, effects);
  await effect('controller', () => io.controller(engine.accounts));
  for (const kind of ['agent', 'hooks']) await image(kind, inputs);
  await effect('policy', observe => io.policy(inputs.policy, observe));
  await effect('egress', async observe => {
    const id = await io.egress(state.owner, observe);
    requireThat(!state.network || state.network === id, 'RESOURCE_NETWORK_DRIFT');
    state.network = id;
  });
  for (const slot of [1, 2]) {
    for (const kind of ['agent', 'hooks']) {
      await resourceProbe(io, state, state.images[kind], engine.namespace, save,
        `${slot}:${kind}`, () => io.availability(
          state.probe.id, kind, inputs));
    }
  }
  const claudePolicy = observe => io.policy(claudeInputs[claude.profileFile],
    observe, policyTargets.claude);
  if (claudeInputs) {
    await image(claude.kind, claudeInputs, state.claude);
    await effect('policy:claude', claudePolicy, state.claude.effects);
    for (const slot of [1, 2]) {
      await resourceProbe(io, state, state.claude.images[claude.kind],
        engine.namespace, save, `${slot}:${claude.kind}`, () => io.availability(
          state.probe.id, claude.kind, claudeInputs), claude.apparmor);
    }
  }
  const profile = managedProfile(engine.namespace, state.images);
  await io.confirmSource();
  for (const kind of ['agent', 'hooks'])
    requireThat(await io.image(kind, state, inputs, true) === state.images[kind],
      'RESOURCE_IMAGE_DRIFT');
  await io.policy(inputs.policy, true);
  requireThat(await io.egress(state.owner, true) === state.network,
    'RESOURCE_NETWORK_DRIFT');
  if (claudeInputs) {
    requireThat(await io.image(claude.kind, state, claudeInputs, true) ===
      state.claude.images[claude.kind], 'RESOURCE_IMAGE_DRIFT');
    await claudePolicy(true);
  }
  const finalEngine = await io.verifyEngine();
  requireThat(finalEngine.identity === engine.identity, 'RESOURCE_ENGINE_CHANGED');
  // The Claude profile replaces only the Codex profile computed from this journal.
  // Once its publish has started, the Claude effect alone checks the profile, so
  // a resumed replace accepts either computed profile and nothing else.
  if (!state.claude?.effects[claudeProfileEffect])
    await effect('profile', () => io.publish(profile));
  const claudeAgent = claudeInputs ? state.claude.images[claude.kind] : undefined;
  if (claudeInputs) {
    const published = managedProfile(engine.namespace, state.images, { claude: {
      image: claudeAgent, version: claudeInputs.versions.claude } });
    await effect(claudeProfileEffect, () => io.publish(published, profile),
      state.claude.effects);
  }
  state.phase = 'prepared';
  await save();
  await io.clearGate(state.owner);
  return preparedResult(state.images, claudeAgent);
}
