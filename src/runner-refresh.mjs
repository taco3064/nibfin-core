import { digest, requireThat } from './identity.mjs';
import { safeRelayCode } from './notification-relay.mjs';
import { githubReadDiagnostic } from './github-read-cause.mjs';

// The installed administrator checks remain outside this composition. It wraps
// the admitted operation once, without an internal delay or another retry loop.
export async function runnerRefreshObservation(operation) {
  try { return await operation(); }
  catch (error) {
    const diagnostic = githubReadDiagnostic(error);
    if (!diagnostic) throw error;
    return { schemaVersion: 1, status: 'pending', ...diagnostic };
  }
}

// These are operation phases, not a second scheduler. Existing maintenance
// serialization owns this call; native/file readback owns every uncertain effect.
export async function refreshRunnerRuntime(mode, ports) {
  requireThat(['preview', 'apply', 'resume'].includes(mode), 'INVALID_RUNNER_REFRESH');
  await ports.inspect();
  await ports.external();
  const binding = await ports.binding();
  let state = await ports.read();
  let previousCleanup;
  const result = () => ({ schemaVersion: 1, status: 'pending',
    phase: state.phase, release: state.selected.release.tag_name,
    code: state.pending ?? undefined,
    ...(state.githubApi ? { githubApi: state.githubApi } : {}) });
  const save = async patch => {
    state = { ...state, ...patch };
    await ports.write(state);
  };
  try {
    if (state) requireThat(state.schemaVersion === 1 &&
      ['preparing', 'draining', 'applying', 'restoring', 'complete']
        .includes(state.phase) &&
      Array.isArray(state.running) && state.running.length === 2 &&
      state.running.every(value => typeof value === 'boolean') && state.slots,
    'RUNNER_REFRESH_STATE_INVALID');
    if (state && state.phase !== 'complete') {
      requireThat(state.schemaVersion === 1 && digest(state.binding) === digest(binding),
        'RUNNER_REFRESH_BINDING_CHANGED');
    } else {
      const selected = await ports.discover();
      const current = await ports.current(selected);
      if (mode === 'preview') return { schemaVersion: 1, status: 'preview',
        release: selected.release.tag_name, current };
      if (state) {
        requireThat(digest(state.binding) === digest(binding),
          'RUNNER_REFRESH_BINDING_CHANGED');
        if (current && digest(state.selected.artifact) === digest(selected.artifact)) {
          await ports.verify(state);
          return finish(state, ports);
        }
        // Retained obsolete material belongs to that completed operation, not
        // the next update. A fresh private workspace leaves it undisturbed.
        try { previousCleanup = await ports.cleanup(state); }
        catch (error) {
          previousCleanup = { status: 'pending', retained: [{ path: state.workspace.path,
            code: safeRelayCode(error) }] };
        }
      }
      if (current) return { schemaVersion: 1, status: 'current',
        release: selected.release.tag_name, continuationRequired: true };
      await ports.settle();
      state = { schemaVersion: 1, phase: 'preparing', binding, selected,
        running: await ports.running(), slots: {}, pending: null,
        workspace: await ports.workspace(), previousCleanup };
      await ports.write(state);
    }
    if (mode === 'preview') return { ...result(), status: 'preview' };
    await ports.inspect();
    if (state.phase === 'preparing') {
      await ports.prepare(state);
      await save({ phase: 'draining' });
    }
    if (state.phase === 'draining') {
      await ports.close(state);
      await ports.settle();
      for (const slot of [1, 2]) {
        await ports.inspect();
        await ports.settle();
        if (!await ports.stopped(slot)) {
          try { await ports.stop(slot, state); }
          catch { /* Read the actual unit after a lost stop response. */ }
          requireThat(await ports.stopped(slot), 'RUNNER_REFRESH_STOP_UNCONFIRMED');
        }
      }
      await save({ phase: 'applying' });
    }
    if (state.phase === 'applying') {
      await ports.closed(state);
      await ports.settle();
      for (const slot of [1, 2]) {
        requireThat(await ports.stopped(slot), 'RUNNER_REFRESH_SERVICE_CHANGED');
        await ports.install(slot, state);
      }
      await ports.verify(state);
      await save({ phase: 'restoring' });
    }
    if (state.phase === 'restoring') {
      await ports.verify(state);
      // Both software trees are now verified. Ordinary admission can resume;
      // no special Listener bypass of the existing drain check is introduced.
      await ports.release(state);
      for (const slot of [1, 2]) {
        if (!state.running[slot - 1]) continue;
        if (!await ports.started(slot)) {
          try { await ports.start(slot); }
          catch { /* A successful read decides whether start already happened. */ }
          requireThat(await ports.started(slot), 'RUNNER_REFRESH_START_UNCONFIRMED');
        }
      }
      await save({ phase: 'complete', pending: null, githubApi: null });
    }
    requireThat(state.phase === 'complete', 'RUNNER_REFRESH_STATE_INVALID');
    return finish(state, ports);
  } catch (error) {
    if (!state) throw error;
    const diagnostic = githubReadDiagnostic(error);
    try {
      await save({ pending: diagnostic?.code ?? safeRelayCode(error),
        githubApi: diagnostic?.githubApi ?? null });
    } catch (saveError) {
      if (!diagnostic) throw saveError;
      return { ...result(), ...diagnostic,
        pendingState: { code: safeRelayCode(saveError) } };
    }
    return result();
  }
}

async function finish(state, ports) {
  // Continuation is deliberately outside the installation transaction/lease.
  // Pending continuation never sends execution back through binary replacement.
  let cleanup;
  try { cleanup = await ports.cleanup(state) ?? { status: 'removed' }; }
  catch (error) { cleanup = { status: 'pending', code: safeRelayCode(error),
    retained: [{ path: state.workspace.path, code: safeRelayCode(error) }] }; }
  return { schemaVersion: 1, status: 'refreshed', phase: 'complete', cleanup,
    ...(state.previousCleanup ? { previousCleanup: state.previousCleanup } : {}),
    release: state.selected.release.tag_name, continuationRequired: true };
}

export async function continueRunnerRefresh(operation, complete) {
  const result = await operation();
  if (!result.continuationRequired) return result;
  const { continuationRequired: unused, ...installation } = result;
  void unused;
  let continuation;
  try { continuation = await complete(); }
  catch (error) { continuation = { status: 'pending',
    ...(githubReadDiagnostic(error) ?? { code: safeRelayCode(error) }) }; }
  requireThat(['dispatched', 'paused', 'pending'].includes(continuation?.status),
    'RUNNER_REFRESH_CONTINUATION_INVALID');
  return { ...installation, continuation };
}
