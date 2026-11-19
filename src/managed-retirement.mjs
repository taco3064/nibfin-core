import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireThat } from './identity.mjs';

const phases = ['draining', 'settling', 'removal', 'cleanup', 'retired'];
const same = isDeepStrictEqual;

// Ports belong to the fixed installed administrator entry. No serialized request
// can supply observations, effects, resource paths or a settlement assertion.
export async function retireManagedPool(binding, ports) {
  let state = await ports.read();
  if (state) {
    requireThat(state.schemaVersion === 1 && phases.includes(state.phase) &&
      same(state.binding, binding), 'RETIREMENT_IDENTITY_CHANGED');
  } else {
    state = { schemaVersion: 1, id: randomUUID(), binding,
      phase: 'draining', effects: {}, pending: 'DRAIN_REQUIRED' };
    await ports.write(state);
  }
  const save = async changes => {
    state = { ...state, ...changes };
    await ports.write(state);
  };
  let removalPermitted = false;
  const result = () => ({ schemaVersion: 1, status:
    state.phase === 'retired' && state.pending === null ? 'retired' : 'pending',
  retirementId: state.id,
  phase: state.phase, code: state.pending,
  removal: { permitted: state.phase === 'removal' && removalPermitted,
    repository: binding.pool.repository,
    repositoryId: binding.pool.repositoryId, memberId: binding.pool.memberId,
    runners: binding.pool.runners } });
  // Each effect is reconciled from readback first, including after interruption.
  // A pending effect with a negative/unknown readback is never blindly repeated.
  const effect = async name => {
    const previous = state.effects[name];
    const observed = await ports.observeEffect(name, state);
    if (observed === 'done') {
      if (previous !== 'done')
        await save({ effects: { ...state.effects, [name]: 'done' } });
      return true;
    }
    if (observed !== 'absent' || previous === 'done' ||
      previous && !ports.retryableEffects?.includes(name)) return false;
    if (!previous)
      await save({ effects: { ...state.effects, [name]: 'intent' } });
    try { await ports.performEffect(name, state); }
    catch { /* Only an independent readback can settle an uncertain write. */ }
    if (await ports.observeEffect(name, state) !== 'done') return false;
    await save({ effects: { ...state.effects, [name]: 'done' } });
    return true;
  };
  try {
    await ports.inspectBinding();
    if (state.phase === 'retired' && state.pending === null) return result();
    if (state.phase === 'retired') await save({ phase: 'cleanup' });
    if (state.phase === 'draining') {
      for (const name of ports.drainEffects ?? ['close-admission', 'relay-pause']) {
        if (!await effect(name)) {
          await save({ pending: 'DRAIN_EFFECT_UNKNOWN' });
          return result();
        }
      }
      await save({ phase: 'settling', pending: 'SETTLEMENT_REQUIRED' });
    }
    // Reconcile every prerequisite on every re-entry. Native absence cannot
    // replace local Writer, journal, service or cgroup termination evidence.
    await ports.assertClosed(state);
    if (state.phase === 'settling') {
      await ports.settleWork?.(state);
      for (const name of ports.settlementEffects ?? []) {
        if (!await effect(name)) {
          await save({ pending: 'SERVICE_SETTLEMENT_UNKNOWN' });
          return result();
        }
      }
    }
    await ports.settle(state);
    if (state.phase === 'settling')
      await save({ phase: 'removal', pending: 'NATIVE_REMOVAL_REQUIRED' });
    const registrations = async () => {
      const values = await ports.registrations(state);
      requireThat(Array.isArray(values) && values.length === 2 &&
        values.every(value => ['present', 'absent'].includes(value)),
      'RETIREMENT_NATIVE_UNKNOWN');
      return values;
    };
    const native = await registrations();
    if (native.some(value => value !== 'absent')) {
      removalPermitted = true;
      if (state.pending !== 'NATIVE_REMOVAL_REQUIRED')
        await save({ pending: 'NATIVE_REMOVAL_REQUIRED' });
      return result();
    }
    if (state.phase !== 'cleanup') {
      const resources = await ports.prepareCleanup?.() ?? {};
      await save({ ...resources, phase: 'cleanup', pending: 'CLEANUP_REQUIRED' });
    }
    for (const name of ports.cleanupEffects) {
      if (!await effect(name)) {
        await save({ pending: 'CLEANUP_EFFECT_UNKNOWN' });
        return result();
      }
    }
    await ports.inspectBinding();
    await ports.assertClosed(state);
    await ports.settle(state);
    requireThat((await registrations()).every(x => x === 'absent'),
      'RETIREMENT_NATIVE_UNKNOWN');
    await save({ phase: 'retired', pending: null });
    return result();
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '')
      ? error.code : 'RETIREMENT_OBSERVATION_UNKNOWN';
    await save({ pending: code });
    return result();
  }
}

export function requireRetiredReplacement(state, pool) {
  requireThat(state?.schemaVersion === 1 && state.phase === 'retired' &&
    state.pending === null && pool.repository === state.binding.pool.repository &&
    pool.repositoryId === state.binding.pool.repositoryId &&
    pool.memberId === state.binding.pool.memberId && pool.runners.length === 2 &&
    pool.runners.every(runner => !state.binding.pool.runners.some(old =>
      old.id === runner.id)), 'RETIREMENT_RELEASE_REQUIRED');
}
