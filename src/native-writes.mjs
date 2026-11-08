import { GitHubReader } from './github-read.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { GitHubWriter, MergeBeforeWrite } from './github-write.mjs';
import { decideStage } from './stages.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';

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
    return async ({ operation, targetHash }) => {
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
      try { fresh = decideStage(stage, await observe(stage), clock()); }
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
  return Object.freeze({
    writerFor,
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
        `nibfin/issue-${issue.number}-${committed.head.slice(0, 12)}`;
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
        const actual = await reader.get(
          `/repos/${issue.repository}/pulls/${existing.number}`,
        );
        requireThat(
          actual.node_id === existing.id &&
            actual.state === 'open' &&
            actual.head?.sha === committed.head &&
            actual.head.ref === branch &&
            actual.head.repo?.id === issue.repositoryId &&
            actual.base.repo?.id === issue.repositoryId,
          'PR_REPAIR_READBACK_UNKNOWN',
        );
        return {
          id: existing.id,
          number: existing.number,
          head: committed.head,
          base: committed.base,
          reference: `https://github.com/${issue.repository}/pull/${existing.number}`,
        };
      }
      await workspace.push(committed.head, branch, token, guard);
      const repository = await reader.repository(issue.repository);
      requireThat(
        repository.id === issue.repositoryId &&
          typeof repository.default_branch === 'string',
        'PUBLICATION_REPOSITORY_CHANGED',
      );
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
        title: `Deliver #${issue.number}`,
        body: [
          'Implements #' + issue.number + '.',
          '',
          'Candidate: ' + digest(context.candidate),
        ].join('\n'),
      });
    },
  });
}
