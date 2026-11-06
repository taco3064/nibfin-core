import { StageRuntime } from './stage-runtime.mjs';
import { nativeObserver } from './native-observer.mjs';
import { nativeWrites } from './native-writes.mjs';
import { stageHandlers } from './stage-handlers.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { evidenceBinding, stages } from './stages.mjs';
import { digest, requireThat } from './identity.mjs';
import { pendingCIObservation } from './github-ci.mjs';
import { pendingMcpObservation } from './mcp-pending.mjs';
import { observationFailureCode } from './observation-failure.mjs';

export function validStageRequest(request) {
  return (
    request !== null &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    Object.keys(request).sort().join(',') === 'schemaVersion,stage' &&
    request.schemaVersion === 1 &&
    typeof request.stage === 'string' &&
    Object.hasOwn(stages, request.stage)
  );
}

// Trusted host composition, not a JSON configuration loader. Only installed
// code supplies adapters and credentials. The public request can select a stage
// but cannot replace its observer, handlers, journal, source or evidence store.
export function nativeStageExecutor({
  reader,
  config,
  execution,
  inspectIsolation,
  inspectSource,
  inspectCaller,
  agent,
  workspace,
  sandbox,
  token,
  fetcher,
  clock = Date.now,
}) {
  const pinned = structuredClone(config),
    actor = structuredClone(execution);
  requireThat(
    typeof pinned?.stateRoot === 'string' &&
      typeof agent?.run === 'function' &&
      typeof workspace?.push === 'function' &&
      typeof sandbox?.execute === 'function',
    'INVALID_STAGE_HOST',
  );
  const observeNative = nativeObserver({
    reader,
    config: pinned,
    execution: actor,
    inspectIsolation,
    inspectSource,
    inspectCaller,
    clock,
  });
  return Object.freeze({
    async run(request) {
      if (!validStageRequest(request))
        return { schemaVersion: 1, status: 'denied', code: 'INVALID_STAGE_REQUEST' };
      const stage = request.stage;
      let initial;
      try {
        initial = await observeNative(stage);
      } catch (error) {
        return {
          schemaVersion: 1,
          stage,
          status: pendingCIObservation(error.code) || pendingMcpObservation(error.code)
            ? 'pending' : 'denied',
          code: pendingCIObservation(error.code) || pendingMcpObservation(error.code)
            ? error.code
            : observationFailureCode(error),
        };
      }
      const binding = evidenceBinding(initial),
        bindingHash = digest(binding);
      const store = new EvidenceStore(pinned.stateRoot, binding);
      const observe = async (currentStage) => {
        const context = await observeNative(currentStage);
        requireThat(
          digest(evidenceBinding(context)) === bindingHash,
          'STAGE_AUTHORITY_CHANGED',
        );
        return context;
      };
      const writes = nativeWrites({ reader, observe, token, workspace, fetcher, clock });
      const handlers = stageHandlers({
        agent,
        workspace,
        sandbox,
        store,
        ...writes,
        clock,
      });
      const runtime = new StageRuntime({
        observe,
        handlers,
        receipts: store,
        clock,
        journal: new OperationJournal(pinned.stateRoot, initial.approval.record.issue),
      });
      return runtime.run({ schemaVersion: 1, stage });
    },
  });
}

// Bounded transport for thin consumers. It never imports a module or reads a
// caller-selected file. A trusted host supplies the executor, not the payload.
export async function runStageInput(input, executor) {
  let request;
  try {
    requireThat(
      typeof input === 'string' && Buffer.byteLength(input) <= 4096,
      'INVALID_STAGE_REQUEST',
    );
    request = JSON.parse(input);
    requireThat(validStageRequest(request), 'INVALID_STAGE_REQUEST');
  } catch {
    return { schemaVersion: 1, status: 'denied', code: 'INVALID_STAGE_REQUEST' };
  }
  try {
    return await executor.run(request);
  } catch {
    return {
      schemaVersion: 1,
      stage: request.stage,
      status: 'pending',
      code: 'TRUSTED_STATE_UNAVAILABLE',
    };
  }
}
