import {
  hostMemoryPressure, confirmedHostPressure, pressureBinding,
} from './host-memory-pressure.mjs';
import { makeBlockerReport } from './blocker-report.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';
import { parseAgentResult } from './agent-result.mjs';
import { enforcementPaths, sameCandidate } from './candidate-evidence.mjs';
import { candidateContract } from './candidate-contract.mjs';
import { runCandidateHooks } from './hooks.mjs';
import { codexIdle, codexPreflightExits, idleDiagnostic } from './codex-bootstrap.mjs';
import { jobVmExecutorFailures } from './job-vm-exec-relay.mjs';
import { writerPressureWait } from './job-vm-pressure.mjs';
import { alignDelivery, handoffDelivery } from './deliver-freshness.mjs';
import { ciCorrectionFindings } from './ci-recovery.mjs';
import { issueRequirementsChanged } from './stages.mjs';

// Only installed adapters enter this factory; the external stage request cannot
// supply functions, commands, paths, credentials, source pins or role identities.
export function stageHandlers({
  agent,
  workspace,
  store,
  sandbox,
  writerFor,
  publishCommit,
  deliverBlockedGuidance,
  persistReport = async report => store.put(report),
  observeMain,
  clock = Date.now,
}) {
  const pathFindings = paths => paths.map(path =>
    `Restore ${path} to the workspace base. Changes require separate approval.`);
  const captureDelivery = async (context, candidate, references) => {
    const shapeHash = context.shape.hash;
    const restricted = enforcementPaths(candidate.paths);
    if (restricted.length) {
      const findings = pathFindings(restricted);
      for (const finding of findings) console.error(`Nibfin deliver: ${finding}`);
      return { outcome: 'changes_required', findings, references,
        artifacts: { shapeHash } };
    }
    const handoff = await handoffDelivery({
      workspace, context, candidate, observeMain, clock,
    });
    if (handoff.outcome)
      return { outcome: handoff.outcome, findings: handoff.findings, references,
        artifacts: { shapeHash, ...(handoff.candidate ? {
          candidateHash: await store.put(handoff.candidate),
        } : {}) } };
    return { outcome: 'ready', findings: [], references,
      artifacts: { shapeHash, candidateHash: await store.put(handoff.candidate) } };
  };
  const handlers = {};
  for (const stage of [
    'shape',
    'validate-shape',
    'deliver',
    'accept',
    'review-pr',
  ]) {
    handlers[stage] = {
      perform: async (context, decision) => {
        // Published Shape text can be reused only while its requirements and
        // independent validation still permit that text.
        const rejectedShape = stage === 'shape' &&
          context.receipts['validate-shape']?.outcome === 'changes_required' &&
          context.receipts['validate-shape'].artifacts.shapeHash ===
            context.receipts.shape?.artifacts.shapeHash
          ? context.receipts['validate-shape'] : null;
        if (stage === 'shape' &&
          context.issue.labels.some(label => label.name === 'shaped') &&
          !rejectedShape && !await issueRequirementsChanged(
            context.issue, context.receipts, hash => store.get(hash),
          ))
          return { publishedShape: context.issue.body };
        if (['accept', 'review-pr'].includes(stage))
          requireThat(
            sameCandidate(await workspace.capture(context.shape.body), context.candidate),
            'REVIEW_CANDIDATE_CHANGED',
          );
        let candidate = context.candidate;
        let reference;
        const resumedDelivery = context.receipts.deliver?.artifacts.shapeHash ===
          context.shape?.hash;
        if (stage === 'deliver' && context.adoptedCandidate && !resumedDelivery &&
          !await workspace.pendingRebase?.(context.shape.body)) {
          const pin = context.adoptedCandidate;
          candidate = await workspace.restoreAdoptedCandidate(pin,
            context.shape.body);
          reference = context.issue.url.replace(/\/issues\/\d+$/, `/pulls/${pin.number}`);
        }
        let rebase;
        const restricted = stage === 'deliver' && candidate?.paths
          ? enforcementPaths(candidate.paths) : [];
        if (stage === 'deliver' && !restricted.length) {
          rebase = await alignDelivery(workspace, context, candidate, clock, true);
        }
        const aligned = rebase?.candidate ?? candidate;
        if (stage === 'deliver' && aligned?.base !== context.main.head) {
          const protectedPaths = enforcementPaths(aligned?.paths ?? []);
          if (protectedPaths.length)
            return { freshnessBlocked: pathFindings(protectedPaths) };
        }
        const correction = stage === 'deliver' && [
          context.receipts['review-pr'], context.receipts.accept,
        ].find(receipt =>
          receipt?.outcome === 'changes_required' &&
          receipt.artifacts.shapeHash === context.shape.hash &&
          receipt.artifacts.candidateHash ===
            context.receipts.deliver?.artifacts.candidateHash);
        const previousDelivery = context.receipts.deliver;
        const deliveryFindings = previousDelivery?.outcome === 'changes_required' &&
          previousDelivery.artifacts.shapeHash === context.shape.hash
          ? previousDelivery.findings : undefined;
        const findings = rejectedShape?.findings ?? (context.ciFailure
          ? ciCorrectionFindings(context.ciFailure)
          : deliveryFindings ?? (restricted.length
            ? pathFindings(restricted) : correction?.findings));
        const retain = reference ||
          (context.candidate && rebase?.status === 'rebased');
        if (!findings && retain && rebase &&
          ['unchanged', 'rebased'].includes(rebase.status) && !rebase.contentChanged) {
          return { retainedCandidate: rebase?.candidate ?? candidate, reference };
        }
        const execution = await agent.run(stage, {
          ...context,
          ...(rebase ? { rebase } : {}),
          ...(findings ? { correctionFindings: findings } : {}),
        });
        if (execution?.status === 'interrupted')
          return { ...execution, artifacts: decision.artifacts };
        return {
          ...execution,
          ...(rebase ? { rebaseStatus: rebase.status,
            rebaseTarget: rebase.latestMain ?? context.main.head } : {}),
        };
      },
      readBack: async (context, execution) => {
        if (stage === 'deliver' && execution.freshnessBlocked)
          return { outcome: 'blocked', findings: execution.freshnessBlocked,
            references: [context.issue.url],
            artifacts: { shapeHash: context.shape.hash } };
        if (stage === 'shape' && execution.publishedShape !== undefined) {
          const body = execution.publishedShape;
          return {
            outcome: 'ready',
            findings: [],
            references: [context.issue.url],
            artifacts: {
              shapeHash: await store.put(body),
            },
          };
        }
        if (stage === 'deliver' && execution.retainedCandidate) {
          const candidate = await workspace.capture(context.shape.body);
          requireThat(sameCandidate(candidate, execution.retainedCandidate),
            'REBASED_WORKTREE_CHANGED');
          return captureDelivery(context, candidate,
            [execution.reference ?? 'evidence:' + digest(context.candidate)]);
        }
        requireThat(
          execution?.executionId === context.execution.id &&
            isDigest(execution.terminationHash),
          'AGENT_TERMINATION_UNPROVEN',
        );
        if (stage === 'deliver') {
          try {
            await workspace.discardWriterGit(execution.terminationHash);
          } catch (error) {
            const finding = error.code === 'UNSAFE_WORKSPACE_PATH'
              ? 'Writer Git metadata is not an ordinary scratch directory.'
              : 'Core could not remove Writer Git scratch after Writer termination.';
            console.error(`Nibfin ${stage}: ${finding}`);
            return {
              outcome: 'blocked',
              findings: [finding],
              references: [context.issue.url],
              artifacts: { shapeHash: context.shape.hash },
            };
          }
        }
        if (execution.status === 'interrupted') {
          const pressure = execution.code === hostMemoryPressure &&
            confirmedHostPressure(execution.memoryPressure,
              pressureBinding(stage, context));
          requireThat(execution.code !== hostMemoryPressure || pressure,
            'HOST_PRESSURE_EVIDENCE_UNVERIFIED');
          const findings = {
            [hostMemoryPressure]: 'Host memory pressure interrupted the Agent.',
            PROCESS_TIMEOUT: 'Agent exceeded its execution time limit and was stopped.',
            [codexIdle.code]: 'Agent was stopped after a period without progress.',
            [writerPressureWait]: 'WSL memory pressure prevented Writer VM startup.',
          };
          const finding = findings[execution.code] ??
            (Object.hasOwn(codexPreflightExits, execution.code) ||
              jobVmExecutorFailures.includes(execution.code)
              ? `Agent environment check failed before the role ran (${execution.code}).`
              : 'Agent process failed and was stopped.');
          const lastProgress = idleDiagnostic(execution.lastProgress ?? '');
          console.error(`Nibfin ${stage}: ${finding}` +
            (lastProgress ? ` (${lastProgress})` : ''));
          const proof = await store.put({
            executionId: execution.executionId,
            terminationHash: execution.terminationHash,
            code: execution.code,
            ...(pressure ? { memoryPressure: execution.memoryPressure, stage } : {}),
            ...(execution.lastProgress ? { lastProgress: execution.lastProgress } : {}),
          });
          const report = makeBlockerReport(context, stage, {
            producer: 'core-native', code: execution.code,
            agentStarted: !Object.hasOwn(codexPreflightExits, execution.code) &&
              !jobVmExecutorFailures.includes(execution.code) &&
              execution.code !== writerPressureWait,
            termination: execution.terminationObservation,
          });
          await persistReport(report);
          return { outcome: 'blocked', findings: [finding], report,
            references: ['evidence:' + proof], artifacts: execution.artifacts };
        }
        const { result } = parseAgentResult(
          stage,
          execution.stdout,
          execution.lastMessage,
          execution.expectedThread,
        );
        const passed = ['ready', 'approved', 'accepted'].includes(result.outcome);
        const report = passed ? undefined : makeBlockerReport(context, stage, {
          result, termination: execution.terminationObservation });
        if (report) await persistReport(report);
        let artifacts =
          stage === 'shape' ? {} : { shapeHash: context.shape.hash };
        if (passed && stage === 'shape') {
          try {
            candidateContract(result.body);
          } catch {
            const finding = 'Author draft has an invalid candidate obligations block.';
            console.error(`Nibfin ${stage}: ${finding}`);
            return {
              outcome: 'blocked',
              findings: [finding],
              references: result.evidenceReferences,
              artifacts,
            };
          }
          artifacts.shapeHash = await store.put(result.body);
        }
        if (stage === 'validate-shape') {
          const prior = context.receipts.shape.artifacts.requirementsHash;
          if (prior) artifacts.requirementsHash = prior;
        }
        if (passed && stage === 'deliver') {
          if (execution.rebaseStatus === 'changes_required') {
            await workspace.continueRebase(
              context.shape.body,
              execution.rebaseTarget,
              execution.terminationHash,
            );
          }
          const candidate = await workspace.capture(context.shape.body);
          return captureDelivery(context, candidate, result.evidenceReferences);
        }
        const blockedGuidance = stage === 'deliver' && result.outcome === 'blocked'
          ? await deliverBlockedGuidance?.(
            context, result.evidenceReferences,
            Boolean(execution.rebaseStatus && execution.rebaseStatus !== 'unchanged'),
          ) : undefined;
        if (['accept', 'review-pr'].includes(stage)) {
          requireThat(
            sameCandidate(await workspace.capture(context.shape.body), context.candidate),
            'REVIEW_CHANGED_CANDIDATE',
          );
          artifacts.candidateHash = digest(context.candidate);
        }
        if (stage === 'review-pr') {
          artifacts = {
            ...artifacts,
            prId: context.pr.id,
            prNumber: context.pr.number,
            head: context.pr.head,
            base: context.pr.base,
            ciHash: await store.put(context.ci),
          };
        }
        return {
          outcome: passed
            ? result.outcome
            : result.outcome === 'changes_required'
              ? 'changes_required'
              : 'blocked',
          report, rootCause: result.rootCause, failureClass: result.failureClass,
          findings: result.blockingFindings,
          references: result.evidenceReferences,
          artifacts,
          ...(blockedGuidance ? { blockedGuidance } : {}),
        };
      },
    };
  }
  handlers['publish-shape'] = {
    perform: async (context, decision) => {
      const writer = writerFor('publish-shape', context, decision);
      const request = {
        issue: context.approval.record.issue,
        expectedBodyHash: digest(context.issue.body),
        expectedLabels: context.issue.labels.map((label) => label.name),
        body: context.shape.body,
      };
      return context.issue.labels.some((label) => label.name === 'shaped') &&
          context.shape.body === context.issue.body
        ? writer.confirmShape(request)
        : writer.publishShape(request);
    },
    readBack: async (context, result) => {
      requireThat(
        result.bodyHash === context.shape.hash,
        'PUBLICATION_RECEIPT_MISMATCH',
      );
      return {
        outcome: 'published',
        findings: [],
        references: [result.reference],
        artifacts: { shapeHash: context.shape.hash,
          ...(context.receipts.shape.artifacts.requirementsHash ? {
            requirementsHash: context.receipts.shape.artifacts.requirementsHash,
          } : {}) },
      };
    },
  };
  for (const [stage, phase] of [
    ['pre-accept-hooks', 'pre-accept'],
    ['post-accept-hooks', 'post-accept'],
  ]) {
    handlers[stage] = {
      perform: async (context) =>
        runCandidateHooks({
          sandbox,
          workspace,
          candidate: context.candidate,
          shapeBody: context.shape.body,
          phase,
          baseline: await workspace.hookBaseline(),
          message: 'Deliver #' + context.approval.record.issue.number +
            '\n\nCandidate: ' + digest(context.candidate) + '\n',
          executionId: context.execution.id,
        }),
      readBack: async (context, result) => {
        requireThat(result.status !== 'pending', 'WRITER_TERMINATION_UNKNOWN');
        const passed = result.status === 'passed';
        if (passed)
          requireThat(
            result.candidateHash === digest(context.candidate),
            'HOOK_RECEIPT_MISMATCH',
          );
        const proof = await store.put(result);
        return {
          outcome: passed ? 'passed' : 'blocked',
          findings: passed ? [] : ['Required isolated hook did not pass'],
          references: [`evidence:${proof}`],
          artifacts: {
            shapeHash: context.shape.hash,
            candidateHash: digest(context.candidate),
          },
        };
      },
    };
  }
  handlers['commit-pr'] = {
    perform: async (context, decision) => {
      const committed = await workspace.commit(
        context.candidate,
        context.shape.body,
        new Date(clock()).toISOString(),
      );
      return publishCommit(context, decision, committed);
    },
    readBack: async (context, pr) => {
      requireThat(pr.base === context.candidate.base, 'PUBLISHED_BASE_MISMATCH');
      return {
        outcome: 'published',
        findings: [],
        references: [pr.reference],
        artifacts: {
          shapeHash: context.shape.hash,
          candidateHash: digest(context.candidate),
          prId: pr.id,
          prNumber: pr.number,
          head: pr.head,
          base: pr.base,
        },
      };
    },
  };
  handlers.merge = {
    perform: async (context, decision) =>
      writerFor('merge', context, decision).merge({
        repository: context.approval.record.issue.repository,
        repositoryId: context.approval.record.issue.repositoryId,
        number: context.pr.number,
        id: context.pr.id,
        head: context.pr.head,
        base: context.pr.base,
        baseBranch: context.pr.baseBranch,
        testMerge: context.ci.testMerge,
        candidateBase: context.candidate.base,
        nativePolicy: context.approval.scopeBinding !== undefined,
      }),
    readBack: async (context, result) => ({
      outcome: 'merged',
      findings: [],
      references: [result.reference],
      artifacts: {
        shapeHash: context.shape.hash,
        candidateHash: digest(context.candidate),
        prId: context.pr.id,
        prNumber: context.pr.number,
        head: context.pr.head,
        base: context.pr.base,
        ciHash: await store.put(context.ci),
        mergeCommit: result.mergeCommit,
      },
    }),
  };
  handlers.close = {
    perform: async (context, decision) =>
      writerFor('close', context, decision).closeDelivered({
        issue: context.approval.record.issue,
        expectedBodyHash: digest(context.issue.body),
        expectedLabels: context.issue.labels.map((label) => label.name),
      }),
    readBack: async (context, result) => {
      requireThat(
        result.bodyHash === digest(context.issue.body),
        'CLOSURE_RECEIPT_MISMATCH',
      );
      return {
        outcome: 'closed',
        findings: [],
        references: [result.reference],
        artifacts: {
          shapeHash: context.shape.hash,
          candidateHash: digest(context.candidate),
          prId: context.pr.id,
          prNumber: context.pr.number,
          head: context.pr.head,
          base: context.pr.base,
          ciHash: await store.put(context.ci),
          mergeCommit: context.pr.mergeCommit,
        },
      };
    },
  };
  return Object.freeze(handlers);
}
