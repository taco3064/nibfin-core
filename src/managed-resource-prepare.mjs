import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './identity.mjs';
import { managedProfile, preparedResult } from './managed-resource-contract.mjs';
import { resourceProbe } from './managed-resource-probe.mjs';

// Pure orchestration; only the installed entry constructs privileged capabilities.
export async function deliverManagedResources(io) {
  const engine = await io.verifyEngine();
  const inputs = await io.inputs();
  let state = await io.load();
  if (!state) {
    await io.pristine();
    state = { version: 1, owner: randomUUID(), inputs: digest(inputs),
      engine: engine.identity, effects: {}, images: {} };
    await io.save(state, null);
  }
  requireThat(state.version === 1 && /^[a-f0-9-]{36}$/.test(state.owner) &&
    state.inputs === digest(inputs) && state.engine === engine.identity &&
    state.images && state.effects, 'RESOURCE_STATE_CONFLICT');
  requireThat(!state.probe || state.probe.phase === 'complete',
    'RESOURCE_PROBE_RECONCILIATION_REQUIRED');
  await io.gate(state.owner);
  let saved = structuredClone(state);
  const save = async () => {
    await io.save(state, saved);
    saved = structuredClone(state);
  };
  const effect = async (key, action) => {
    const previous = state.effects[key];
    requireThat(previous === undefined || ['pending', 'complete'].includes(previous),
      'RESOURCE_STATE_CONFLICT');
    if (!previous) {
      state.effects[key] = 'pending';
      await save();
    }
    await action(previous !== undefined);
    state.effects[key] = 'complete';
    await save();
  };
  await effect('controller', () => io.controller(engine.accounts));
  for (const kind of ['agent', 'hooks']) {
    await effect(`image:${kind}`, async observe => {
      const id = await io.image(kind, state, inputs, observe);
      requireThat(/^sha256:[a-f0-9]{64}$/.test(id) &&
        (!state.images[kind] || state.images[kind] === id), 'RESOURCE_IMAGE_DRIFT');
      state.images[kind] = id;
    });
  }
  await effect('policy', observe => io.policy(inputs.policy, observe));
  await effect('egress', async observe => {
    const id = await io.egress(state.owner, observe);
    requireThat(!state.network || state.network === id, 'RESOURCE_NETWORK_DRIFT');
    state.network = id;
  });
  for (const slot of [1, 2]) {
    for (const kind of ['agent', 'hooks']) {
      await resourceProbe(io, state, state.images[kind], engine.namespace, save,
        `${slot}:${kind}`);
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
  const finalEngine = await io.verifyEngine();
  requireThat(finalEngine.identity === engine.identity, 'RESOURCE_ENGINE_CHANGED');
  await effect('profile', () => io.publish(profile));
  state.phase = 'prepared';
  await save();
  await io.clearGate(state.owner);
  return preparedResult(state.images);
}
