import { digest, requireThat } from './identity.mjs';
import { decideStage, stages } from './stages.mjs';
import { MergeBeforeWrite } from './github-write.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { pendingMcpObservation } from './mcp-pending.mjs';
import { observationFailureCode } from './observation-failure.mjs';
import { codexIdle } from './codex-bootstrap.mjs';

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
      return {
        schemaVersion: 1,
        status: pendingObservation(error.code) ? 'pending' : 'denied',
        code: pendingObservation(error.code)
          ? error.code : observationFailureCode(error),
        stage,
      };
    }
    const decision = decideStage(stage, context, this.#clock());
    if (decision.status !== 'allowed') return decision;
    const frozenContextHash = digest(context);
    let result, receiptHash, receipt, admissionError;
    try {
      const outcome = await this.#journal.run(
        { operation: decision.operation, bindingHash: decision.requestHash },
        {
          admit: async () => {
            let fresh;
            try {
              fresh = decideStage(stage, await this.#observe(stage), this.#clock());
              if (stage === 'merge' && fresh.status === 'allowed' &&
                fresh.requestHash !== decision.requestHash) throw new MergeBeforeWrite();
            } catch (error) { admissionError = error; throw error; }
            requireThat(
              fresh.status === 'allowed' && fresh.requestHash === decision.requestHash,
              'ADMISSION_CHANGED',
            );
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
      if (pendingObservation(admissionError?.code) ||
        integrationRepairRequired(admissionError?.code)) {
        return { schemaVersion: 1, stage, code: admissionError.code,
          status: pendingObservation(admissionError.code) ? 'pending' : 'denied' };
      }
      if (outcome.status !== 'completed') return { schemaVersion: 1, stage, ...outcome };
      const code = result?.status === 'interrupted' &&
        result.code === codexIdle.code ? codexIdle.code : 'STAGE_REQUIRES_CORRECTION';
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
