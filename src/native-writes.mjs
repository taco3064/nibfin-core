import { issuePath, GitHubReader } from './github-read.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { GitHubWriter, MergeBeforeWrite } from './github-write.mjs';
import { decideStage } from './stages.mjs';
import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { setTimeout } from 'node:timers/promises';
import {
  deliveryLifecycle, matchesDeliveryCheckpoint, publishedDeliveryBranch,
  readDeliveryCheckpoint,
} from './delivery-checkpoint.mjs';

// Installed Core assembly. Neither credentials nor the observer are provided by
// a stage request. Re-admit separately before every remote mutation, including
// the push and the subsequent PR creation inside the same durable operation.
export function nativeWrites({
  reader,
  observe,
  token,
  workspace,
  fetcher,
  clock = Date.now,
  wait = setTimeout,
}) {
  requireThat(
    typeof observe === 'function' &&
      typeof token === 'string' &&
      token.trim() &&
      typeof workspace?.push === 'function',
    'INVALID_NATIVE_WRITE_ASSEMBLY',
  );
  const guardFor = (stage, context, decision) => {
    const original = decideStage(stage, context, clock());
    requireThat(
      original.status === 'allowed' && digest(original) === digest(decision),
      'WRITE_DECISION_MISMATCH',
    );
    return async ({ operation, targetHash, settlementLabel }) => {
      requireThat(
        operation === original.operation && isDigest(targetHash),
        'WRITE_TARGET_INVALID',
      );
      const actor = await new GitHubReader(token, fetcher).get('/user');
      requireThat(
        actor.type === 'User' && actor.id === context.execution.actorId,
        'WRITE_CREDENTIAL_IDENTITY_MISMATCH',
      );
      let fresh;
      try {
        let observed = await observe(stage);
        if (settlementLabel !== undefined) {
          // Account only for the confirmed additive effect of this admitted
          // lifecycle operation, binding the exact remaining PATCH payload.
          const label = stage === 'publish-shape' ? 'shaped' : 'delivered';
          const body = stage === 'publish-shape' ? { body: context.shape.body }
            : { state: 'closed', state_reason: 'completed' };
          requireThat(['publish-shape', 'close'].includes(stage) &&
            settlementLabel === label &&
            !context.issue.labels.some(item => item.name === label) &&
            observed.issue.labels.filter(item => item.name === label).length === 1 &&
            targetHash === digest({ operation, method: 'PATCH',
              path: issuePath(context.approval.record.issue), body }),
          'WRITE_SETTLEMENT_MISMATCH');
          observed = { ...observed, issue: { ...observed.issue,
            labels: observed.issue.labels.filter(item => item.name !== label) } };
        }
        // This guard settles the stage already admitted by StageRuntime. Pause
        // gates the next admission; all positive authority is still read fresh.
        fresh = decideStage(stage, { ...observed, pause: context.pause }, clock());
      }
      catch (error) {
        if (stage === 'merge' && (pendingCIObservation(error.code) ||
          integrationRepairRequired(error.code))) throw new MergeBeforeWrite();
        throw error;
      }
      if (stage === 'merge' && fresh.status === 'allowed' &&
        fresh.requestHash !== original.requestHash) throw new MergeBeforeWrite();
      requireThat(
        fresh.status === 'allowed' && fresh.requestHash === original.requestHash,
        'WRITE_AUTHORITY_CHANGED',
      );
      return { targetHash, bindingHash: fresh.requestHash };
    };
  };
  const writerFor = (stage, context, decision) =>
    new GitHubWriter({
      reader,
      token,
      fetcher,
      guard: guardFor(stage, context, decision),
    });
  const checkpointBinding = context => ({
    shape: context.shape.body, lifecycle: deliveryLifecycle(context),
  });
  const observeDeliver = context => readDeliveryCheckpoint(reader,
    context.approval.record.issue, checkpointBinding(context));
  return Object.freeze({
    writerFor,
    observeDeliver,
    restoreDeliver: (checkpoint, shape) =>
      workspace.restoreDeliveryCheckpoint(checkpoint, shape, token),
    saveDeliver: async (context, decision, candidate, checkpoint, mode = 'completed') => {
      requireThat(context.approval.record.operations.includes('commit-pr') &&
        context.approval.record.roles.publisher === context.execution.actorId,
      'DELIVER_CHECKPOINT_PUBLICATION_NOT_APPROVED');
      const read = () => observeDeliver(context);
      const observed = await read();
      if (matchesDeliveryCheckpoint(observed, candidate, mode)) return observed;
      requireThat(observed.head === checkpoint.head, 'DELIVER_BRANCH_ADVANCED');
      requireThat(observed.head === null || observed.owned,
        'DELIVER_BRANCH_OWNERSHIP_UNPROVEN');
      const committed = await workspace.commit(candidate, context.shape.body,
        new Date(clock()).toISOString(), mode === 'progress',
        { ...checkpointBinding(context), mode });
      const guard = async write => {
        const admission = await guardFor('deliver', context, decision)(write);
        const fresh = await observe('deliver');
        requireThat(deliveryLifecycle(fresh) === deliveryLifecycle(context),
          'DELIVER_LIFECYCLE_CHANGED');
        return admission;
      };
      let writeError;
      try {
        await workspace.push(committed.head, observed.branch, token, guard,
          observed.head, 'deliver');
      } catch (error) { writeError = error; }
      // Native readback also covers a push that landed but lost its local reply.
      const actual = await read();
      if (matchesDeliveryCheckpoint(actual, candidate, mode)) return actual;
      if (writeError && writeError.code !== 'PROCESS_FAILED') throw writeError;
      if (writeError) throw Object.assign(new Error('DELIVER_CHECKPOINT_PUSH_FAILED'), {
        code: 'DELIVER_CHECKPOINT_PUSH_FAILED', cause: writeError,
      });
      requireThat(false, 'DELIVER_CHECKPOINT_READBACK_PENDING');
    },
    publishCommit: async (context, decision, committed) => {
      requireThat(
        committed.tree === context.candidate.tree &&
          committed.base === context.candidate.base,
        'COMMIT_CANDIDATE_MISMATCH',
      );
      const issue = context.approval.record.issue;
      const existing = context.pr;
      const branch =
        existing?.headBranch ??
        publishedDeliveryBranch(issue, committed.head);
      const guard = guardFor('commit-pr', context, decision);
      if (existing) {
        requireThat(
          existing.state === 'open' &&
            existing.repositoryId === issue.repositoryId &&
            typeof existing.headBranch === 'string',
          'EXISTING_PR_NOT_REPAIRABLE',
        );
        // A guarded lease updates only the observed PR branch. Never force main
        // or silently create a second PR when another writer moved this head.
        const before = await reader.get(
          `/repos/${issue.repository}/pulls/${existing.number}`,
        );
        requireThat(
          before.node_id === existing.id &&
            before.head?.sha === existing.head &&
            before.head.ref === branch &&
            before.head.repo?.id === issue.repositoryId &&
            before.state === 'open',
          'PR_REPAIR_HEAD_CHANGED',
        );
        await workspace.push(committed.head, branch, token, guard, existing.head);
        // The PR API can still show the exact prior head after a successful push.
        for (let attempt = 0; ; attempt++) {
          const actual = await reader.get(
            `/repos/${issue.repository}/pulls/${existing.number}`,
          );
          requireThat(
            actual.node_id === existing.id &&
              actual.state === 'open' &&
              actual.head?.ref === branch &&
              actual.head.repo?.id === issue.repositoryId &&
              actual.base.repo?.id === issue.repositoryId,
            'PR_REPAIR_READBACK_UNKNOWN',
          );
          if (actual.head.sha === committed.head) break;
          requireThat(
            actual.head.sha === existing.head && attempt < 5,
            'PR_REPAIR_READBACK_UNKNOWN',
          );
          await wait(1000);
        }
        return {
          id: existing.id,
          number: existing.number,
          head: committed.head,
          base: committed.base,
          reference: `https://github.com/${issue.repository}/pull/${existing.number}`,
        };
      }
      const repository = await reader.repository(issue.repository);
      requireThat(
        repository.id === issue.repositoryId &&
          typeof repository.default_branch === 'string',
        'PUBLICATION_REPOSITORY_CHANGED',
      );
      const title = `Deliver #${issue.number}`;
      const body = ['Implements #' + issue.number + '.', '',
        'Candidate: ' + digest(context.candidate)].join('\n');
      if (committed.saved) {
        const checkpointPr = committed.saved.publication;
        if (checkpointPr?.actorId === context.execution.actorId &&
            checkpointPr.baseBranch === repository.default_branch &&
            checkpointPr.title === title && checkpointPr.body === body &&
            typeof checkpointPr.id === 'string' && isId(checkpointPr.number)) {
          const { id, number } = checkpointPr;
          return { id, number, head: committed.head, base: committed.base,
            reference: `https://github.com/${issue.repository}/pull/${number}` };
        }
        const ref = await reader.get(`/repos/${issue.repository}/branches/` +
          encodeURIComponent(branch)).catch(error => {
          if (error.status === 404 && error.githubApiRead === true) return null;
          throw error;
        });
        requireThat(!ref || ref.commit?.sha === committed.head,
          'PR_REPAIR_HEAD_CHANGED');
        if (!ref) await workspace.push(committed.head, branch, token, guard);
      } else await workspace.push(committed.head, branch, token, guard);
      return new GitHubWriter({
        reader,
        token,
        guard,
        fetcher,
      }).createPullRequest({
        repository: issue.repository,
        repositoryId: issue.repositoryId,
        headBranch: branch,
        head: committed.head,
        baseBranch: repository.default_branch,
        base: committed.base,
        title,
        body,
      });
    },
    reuseDeliverCommit: async context => {
      if (!context.receipts.deliver?.deliveryCheckpoint) return null;
      const checkpoint = await observeDeliver(context);
      if (matchesDeliveryCheckpoint(checkpoint, context.candidate) &&
          checkpoint.originalCandidate === digest(context.candidate)) return {
        head: checkpoint.head, tree: checkpoint.tree, base: checkpoint.parent,
        saved: checkpoint,
      };
      return null;
    },
  });
}
