import { digest, isDigest, requireThat } from './identity.mjs';
import { parseAgentResult } from './agent-result.mjs';
import { candidateContract } from './candidate-contract.mjs';
import { runCandidateHooks } from './hooks.mjs';

// Only installed adapters enter this factory; the external stage request cannot
// supply functions, commands, paths, credentials, source pins or role identities.
export function stageHandlers({
  agent,
  workspace,
  store,
  sandbox,
  writerFor,
  publishCommit,
  clock = Date.now,
}) {
  const handlers = {};
  for (const stage of [
    'shape',
    'validate-shape',
    'deliver',
    'accept',
    'review-pr',
  ]) {
    handlers[stage] = {
      perform: async (context) => {
        if (['accept', 'review-pr'].includes(stage))
          requireThat(
            digest(await workspace.capture(context.shape.body)) ===
              digest(context.candidate),
            'REVIEW_CANDIDATE_CHANGED',
          );
        let rebase;
        if (stage === 'deliver' && context.rebaseTarget) {
          rebase = await workspace.rebase(
            context.candidate,
            context.shape.body,
            context.rebaseTarget,
            new Date(clock()).toISOString(),
          );
        }
        const execution = await agent.run(stage, {
          ...context,
          ...(rebase ? { rebase } : {}),
        });
        return {
          ...execution,
          ...(rebase ? { rebaseStatus: rebase.status } : {}),
        };
      },
      readBack: async (context, execution) => {
        requireThat(
          execution?.executionId === context.execution.id &&
            isDigest(execution.terminationHash),
          'AGENT_TERMINATION_UNPROVEN',
        );
        const { result } = parseAgentResult(
          stage,
          execution.stdout,
          execution.lastMessage,
          execution.expectedThread,
        );
        const passed = ['ready', 'approved', 'accepted'].includes(result.outcome);
        let artifacts =
          stage === 'shape' ? {} : { shapeHash: context.shape.hash };
        if (passed && stage === 'shape') {
          if (context.issue.labels.some((label) => label.name === 'shaped'))
            requireThat(
              result.body === context.issue.body,
              'CURRENT_SHAPE_REVALIDATION_CHANGED',
            );
          candidateContract(result.body);
          artifacts.shapeHash = await store.put(result.body);
        }
        if (passed && stage === 'deliver') {
          if (execution.rebaseStatus === 'changes_required') {
            await workspace.continueRebase(
              context.shape.body,
              context.main.head,
              execution.terminationHash,
            );
          }
          const candidate = await workspace.capture(context.shape.body);
          artifacts.candidateHash = await store.put(candidate);
        }
        if (['accept', 'review-pr'].includes(stage)) {
          requireThat(
            digest(await workspace.capture(context.shape.body)) ===
              digest(context.candidate),
            'REVIEW_CHANGED_CANDIDATE',
          );
          artifacts.candidateHash = digest(context.candidate);
        }
        if (stage === 'review-pr') {
          artifacts = {
            ...artifacts,
            prId: context.pr.id,
            prNumber: context.pr.number,
            head: context.pr.publishedHead ?? context.pr.head,
          };
        }
        return {
          outcome: passed
            ? result.outcome
            : result.outcome === 'changes_required'
              ? 'changes_required'
              : 'blocked',
          findings: result.blockingFindings,
          references: result.evidenceReferences,
          artifacts,
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
      return context.issue.labels.some((label) => label.name === 'shaped')
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
        artifacts: { shapeHash: context.shape.hash },
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
