import { digest, requireThat } from './identity.mjs';
import { decideStage, stageAdmissionFields, stages } from './stages.mjs';
import { MergeBeforeWrite } from './github-write.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { pendingMcpObservation } from './mcp-pending.mjs';
import { githubReadWait, observationFailureCode } from './observation-failure.mjs';
import { codexIdle, codexPreflightExits } from './codex-bootstrap.mjs';
import { jobVmExecutorFailures } from './job-vm-exec-relay.mjs';
import { writerPressureWait } from './job-vm-pressure.mjs';
import { ciFailureResult } from './ci-recovery.mjs';

export const stageSuccess = Object.freeze({
  shape: 'ready',
  'validate-shape': 'approved',
  'publish-shape': 'published',
  deliver: 'ready',
  'pre-accept-hooks': 'passed',
  accept: 'accepted',
  'post-accept-hooks': 'passed',
  'commit-pr': 'published',
  'review-pr': 'approved',
  merge: 'merged',
  close: 'closed',
});
const success = stageSuccess;
const pendingObservation = code =>
  pendingCIObservation(code) || pendingMcpObservation(code);

// Report field names from trusted schemas only. Issue text, credentials and
// observation values stay out of workflow logs.
function changedFields(prefix, before, after, keys) {
  return keys.filter(key =>
    digest(before?.[key] ?? null) !== digest(after?.[key] ?? null))
    .map(key => prefix + key);
}

function admissionChanges(before, after, decision, fresh) {
  const first = stageAdmissionFields(before, decision);
  const next = stageAdmissionFields(after, fresh);
  const fields = changedFields('', first, next, ['requirements', 'runner', 'isolation']);
  for (const [group, keys] of [
    ['binding', ['issueId', 'approvalHash', 'scopeHash', 'sourceHash']],
    ['execution', ['id', 'sessionId', 'role', 'actorId', 'runId', 'attempt', 'jobId']],
    ['artifacts', ['shapeHash', 'requirementsHash', 'candidateHash', 'prId',
      'prNumber', 'head', 'base', 'ciHash', 'mergeCommit']],
    ['writeTarget', ['id', 'head', 'branch']],
  ]) {
    if (digest(first[group] ?? null) === digest(next[group] ?? null)) continue;
    const changes = changedFields(group + '.', first[group], next[group], keys);
    fields.push(...(changes.length ? changes : [group]));
  }
  if (fields.includes('artifacts.ciHash')) {
    fields.push(...changedFields('ci.', before.ci, after.ci, [
      'prId', 'head', 'base', 'testedSha', 'testMerge', 'parents', 'checks',
      'protectionHash', 'provenanceHash', 'sources', 'observedChecks',
    ]));
  }
  fields.push(...changedFields('main.', before.main, after.main, ['head']));
  return fields;
}

// Construct only in trusted installed Core. Adapters are code-owned and cannot be
// overridden by a stage request, event, Issue or worktree. No arbitrary command
// or adapter module path is accepted by this API.
export class StageRuntime {
  #observe;
  #handlers;
  #journal;
  #receipts;
  #clock;
  constructor({ observe, handlers, journal, receipts, clock = Date.now }) {
    requireThat(
      typeof observe === 'function' &&
        typeof journal?.run === 'function' &&
        typeof receipts?.append === 'function' &&
        typeof clock === 'function',
      'INVALID_RUNTIME_ADAPTERS',
    );
    this.#observe = observe;
    this.#handlers = Object.freeze({ ...handlers });
    this.#journal = journal;
    this.#receipts = receipts;
    this.#clock = clock;
  }
  async run(request) {
    if (
      !request ||
      Object.keys(request).sort().join(',') !== 'schemaVersion,stage' ||
      request.schemaVersion !== 1 ||
      !Object.hasOwn(stages, request.stage)
    )
      return { schemaVersion: 1, status: 'denied', code: 'INVALID_STAGE_REQUEST' };
    const stage = request.stage,
      handler = this.#handlers[stage];
    if (
      typeof handler?.perform !== 'function' ||
      typeof handler?.readBack !== 'function'
    ) {
      return {
        schemaVersion: 1,
        status: 'denied',
        code: 'UNSUPPORTED_STAGE_ADAPTER',
        stage,
      };
    }
    let context;
    try {
      context = structuredClone(await this.#observe(stage));
    } catch (error) {
      return ciFailureResult(error, stage) ?? {
        schemaVersion: 1,
        status: pendingObservation(error.code) ? 'pending' : 'denied',
        code: pendingObservation(error.code)
          ? error.code : observationFailureCode(error),
        stage,
      };
    }
    const checkObservations = context.checkObservations;
    delete context.checkObservations;
    const decision = decideStage(stage, context, this.#clock());
    if (decision.status !== 'allowed') return decision;
    const frozenContextHash = digest(context);
    let result, receiptHash, receipt, admissionError, freshDenial, changed;
    let checkObservationDiff;
    try {
      const outcome = await this.#journal.run(
        { operation: decision.operation, bindingHash: decision.requestHash },
        {
          admit: async () => {
            let fresh;
            try {
              const observation = await this.#observe(stage);
              if (digest(observation.pause ?? null) !== digest(context.pause ?? null)) {
                changed = changedFields('pause.', context.pause, observation.pause,
                  ['status', 'effective', 'visible', 'repair', 'issue',
                    'observationHash']);
                if (!changed.length) changed = ['pause'];
                requireThat(false, 'PAUSE_OBSERVATION_CHANGED');
              }
              fresh = decideStage(stage, observation, this.#clock());
              if (fresh.status !== 'allowed') freshDenial = fresh;
              if (fresh.status === 'allowed' &&
                fresh.requestHash !== decision.requestHash) {
                changed = admissionChanges(context, observation, decision, fresh);
                if (changed.includes('ci.observedChecks') &&
                  checkObservations && observation.checkObservations) {
                  checkObservationDiff = {
                    before: checkObservations,
                    after: observation.checkObservations,
                  };
                }
                if (stage === 'merge') throw new MergeBeforeWrite();
                requireThat(stage !== 'review-pr' || !changed.length ||
                  !changed.every(field => field === 'artifacts.ciHash' ||
                    field.startsWith('ci.')), 'CI_CHANGED_DURING_READ');
              }
              requireThat(
                fresh.status === 'allowed' && fresh.requestHash === decision.requestHash,
                'ADMISSION_CHANGED',
              );
            } catch (error) { admissionError = error; throw error; }
            return fresh.requestHash;
          },
          perform: async () => {
            requireThat(digest(context) === frozenContextHash, 'CONTEXT_CHANGED');
            // Handlers never receive the journal, credentials of other adapters,
            // a caller-selected function, or mutable authority configuration.
            result = await handler.perform(
              structuredClone(context),
              structuredClone(decision),
            );
          },
          readBack: async () => {
            const verified = await handler.readBack(
              structuredClone(context),
              structuredClone(result),
            );
            requireThat(
              verified &&
                [success[stage], 'blocked', 'changes_required'].includes(
                  verified.outcome,
                ) &&
                Array.isArray(verified.findings) &&
                verified.findings.every(
                  (value) => typeof value === 'string' && value.trim(),
                ) &&
                Array.isArray(verified.references) &&
                verified.references.length > 0 &&
                verified.references.every(
                  (value) => typeof value === 'string' && value.trim(),
                ) &&
                verified.artifacts &&
                Object.entries(decision.artifacts).every(
                  ([key, value]) => verified.artifacts[key] === value,
                ),
              'INVALID_STAGE_READBACK',
            );
            requireThat(
              verified.outcome === success[stage]
                ? verified.findings.length === 0
                : verified.findings.length > 0,
              'INCONSISTENT_STAGE_OUTCOME',
            );
            receipt = {
              schemaVersion: 1,
              stage,
              binding: decision.binding,
              execution: context.execution,
              artifacts: verified.artifacts,
              ...(stage === 'shape' ? { requirementsBody: context.issue.body } : {}),
              ...(stage === 'publish-shape'
                ? { requirementsBody: context.shape.body } : {}),
              outcome: verified.outcome,
              findings: verified.findings,
              references: verified.references,
            };
            receiptHash = await this.#receipts.append(receipt);
            requireThat(receiptHash === digest(receipt), 'RECEIPT_PERSISTENCE_FAILED');
            return decision.requestHash;
          },
        },
      );
      const ciFailure = ciFailureResult(admissionError, stage);
      if (ciFailure) return ciFailure;
      const waiting = githubReadWait(admissionError, this.#clock());
      if (waiting && outcome.code === 'ADMISSION_FAILED')
        return { schemaVersion: 1, stage, ...waiting };
      if (outcome.code === 'ADMISSION_FAILED' && freshDenial) return freshDenial;
      if (pendingObservation(admissionError?.code) ||
        integrationRepairRequired(admissionError?.code)) {
        return { schemaVersion: 1, stage, code: admissionError.code,
          status: pendingObservation(admissionError.code) ? 'pending' : 'denied',
          ...(changed?.length ? { changedFields: changed } : {}),
          ...(checkObservationDiff ? { checkObservationDiff } : {}) };
      }
      if (outcome.code === 'ADMISSION_FAILED' && admissionError) {
        const code = admissionError.code;
        const admissionCodes = ['PAUSE_OBSERVATION_CHANGED', 'ADMISSION_CHANGED'];
        return { schemaVersion: 1, stage, status: 'denied',
          code: admissionCodes.includes(code)
            ? code : observationFailureCode(admissionError),
          ...(changed?.length ? { changedFields: changed } : {}),
          ...(checkObservationDiff ? { checkObservationDiff } : {}) };
      }
      if (outcome.status !== 'completed') return { schemaVersion: 1, stage, ...outcome };
      const knownInterruption = result?.code === codexIdle.code ||
        Object.hasOwn(codexPreflightExits, result?.code) ||
        jobVmExecutorFailures.includes(result?.code) || result?.code === writerPressureWait;
      const code = result?.status === 'interrupted' && knownInterruption
        ? result.code : 'STAGE_REQUIRES_CORRECTION';
      return {
        schemaVersion: 1,
        stage,
        status: receipt.outcome === success[stage] ? 'completed' : 'denied',
        code:
          receipt.outcome === success[stage]
            ? 'STAGE_COMPLETED'
            : code,
        receiptHash,
      };
    } catch {
      return {
        schemaVersion: 1,
        stage,
        status: 'pending',
        code: 'TRUSTED_STATE_UNAVAILABLE',
      };
    }
  }
}
