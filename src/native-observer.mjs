import { readProtectedApproval, readMemberPermission } from './github-approval.mjs';
import { readCurrentMain } from './current-main.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readDependencies } from './dependencies.mjs';
import { readPullRequestCI } from './github-ci.mjs';
import { selectAssignee } from './selection.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { evidenceBinding, stages } from './stages.mjs';
import { equivalentCandidate } from './candidate-evidence.mjs';
import { repoPath } from './github-read.mjs';
import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { readAdoptedOpenPr } from './adopt-open-pr.mjs';

// Wiring belongs to installed Core. Config and inspection functions are never
// selected by the public stage request. Neither GitHub events nor local JSON
// pretending to be an observation can be passed through this API as authority.
export function nativeObserver({
  reader,
  config,
  execution,
  inspectIsolation,
  inspectSource,
  inspectCaller,
  clock = Date.now,
  stores = (binding) => new EvidenceStore(config.stateRoot, binding),
}) {
  requireThat(
    typeof inspectIsolation === 'function' &&
      typeof inspectSource === 'function' &&
      typeof inspectCaller === 'function',
    'TRUSTED_OBSERVERS_REQUIRED',
  );
  const pinned = structuredClone(config),
    actor = structuredClone(execution);
  return async (stage) => {
    requireThat(Object.hasOwn(stages, stage), 'UNKNOWN_STAGE');
    const approval = await readProtectedApproval(reader, pinned.approval, clock());
    const record = approval.record;
    const observed = await readDependencies(reader, record.issue, record.prerequisites);
    requireThat(observed.ready, 'PREREQUISITES_NOT_READY');
    const route = await selectAssignee(observed.issue, async (user) => {
      if (user.id !== record.roles.writer) return false;
      try {
        await readMemberPermission(reader, record.issue.repository, {
          ...user,
          type: 'User',
        });
        return true;
      } catch (error) {
        if (error.code === 'MEMBER_PERMISSION_REVOKED') return false;
        throw error;
      }
    });
    requireThat(
      route && route.userId === pinned.runner.memberId,
      'ASSIGNEE_RUNNER_BINDING_CHANGED',
    );
    const runner = await readRunnerBinding(reader, pinned.runner);
    const caller = await inspectCaller(runner);
    requireThat(
      caller?.repositoryId === runner.repositoryId &&
        caller.runId === runner.runId &&
        caller.attempt === runner.attempt &&
        caller.checkRunId === runner.checkRunId &&
        caller.actorId === runner.actorId &&
        caller.sourceCommit === runner.sourceCommit &&
        caller.expiresAt > clock() &&
        isDigest(caller.identityHash),
      'AUTHENTICATED_CALLER_REQUIRED',
    );
    const source = await inspectSource();
    requireThat(digest(source) === digest(record.source), 'INSTALLED_SOURCE_CHANGED');
    const store = stores(evidenceBinding({ approval })),
      receipts = await store.load();
    const main = await readCurrentMain(reader, record.issue);
    const context = {
      approval,
      main,
      issue: observed.issue,
      dependencies: { ready: true, identities: record.prerequisites },
      route,
      runner,
      source,
      receipts,
      execution: actor,
    };
    if (receipts.shape?.outcome === 'ready') {
      const body = await store.get(receipts.shape.artifacts.shapeHash);
      context.shape = { body, hash: digest(body) };
    }
    if (receipts.deliver?.outcome === 'ready')
      context.candidate = await store.get(receipts.deliver.artifacts.candidateHash);
    if (context.candidate) {
      context.equivalentCandidates = [];
      const reusable = ['pre-accept-hooks', 'accept', 'post-accept-hooks', 'review-pr'];
      for (const stage of reusable) {
        const hash = receipts[stage]?.artifacts?.candidateHash;
        if (hash && !context.equivalentCandidates.includes(hash) &&
          await equivalentCandidate(store, context.candidate, hash)) {
          context.equivalentCandidates.push(hash);
        }
      }
    }
    if (stage === 'deliver' && pinned.openPr && !context.candidate &&
      !receipts['commit-pr']) {
      await readAdoptedOpenPr(reader, record.issue, pinned.openPr,
        record.roles.publisher);
      context.adoptedCandidate = pinned.openPr;
    }
    if (stage === 'commit-pr' && pinned.openPr &&
      receipts['commit-pr']?.outcome !== 'published') {
      context.pr = await readAdoptedOpenPr(reader, record.issue, pinned.openPr,
        record.roles.publisher);
      context.adoptedOpenPr = true;
    }
    if (receipts['commit-pr']?.outcome === 'published') {
      const saved = receipts['commit-pr'].artifacts;
      requireThat(isId(saved.prNumber) && isSha(saved.head), 'INVALID_PR_RECEIPT');
      const root = repoPath(record.issue.repository),
        pr = await reader.get(`${root}/pulls/${saved.prNumber}`);
      requireThat(
        pr.node_id === saved.prId &&
          pr.number === saved.prNumber &&
          isSha(pr.head?.sha) &&
          pr.head.repo?.id === record.issue.repositoryId &&
          pr.base.repo?.id === record.issue.repositoryId,
        'PR_RECEIPT_IDENTITY_CHANGED',
      );
      const published = saved.candidateHash === digest(context.candidate ?? null)
        ? context.candidate : await store.get(saved.candidateHash);
      const commit = await reader.get(`${root}/git/commits/${pr.head.sha}`);
      requireThat(
        commit.sha === pr.head.sha && isSha(commit.tree?.sha),
        'PR_HEAD_TREE_UNAVAILABLE',
      );
      requireThat(
        Array.isArray(commit.parents) &&
          commit.parents.length === 1 &&
          commit.parents[0].sha === published.base,
        'PR_CANDIDATE_PARENT_CHANGED',
      );
      requireThat(pr.head.sha === saved.head || commit.tree.sha === published.tree,
        'PR_CANDIDATE_CONTENT_CHANGED');
      context.pr = {
        id: pr.node_id,
        number: pr.number,
        repositoryId: record.issue.repositoryId,
        head: pr.head.sha,
        publishedHead: saved.head,
        headBranch: pr.head.ref,
        base: pr.base.sha,
        baseBranch: pr.base.ref,
        tree: commit.tree.sha,
        state: pr.state,
        merged: pr.merged,
        mergePreview: pr.merge_commit_sha,
        ...(pr.merged ? { mergeCommit: pr.merge_commit_sha } : {}),
      };
      if (stage === 'deliver' && context.candidate && pr.state === 'open' &&
        receipts.deliver.artifacts.shapeHash === context.shape?.hash &&
        (pr.mergeable === false || pr.mergeable_state === 'behind')) {
        context.rebaseTarget = main.head;
      }
      if (['review-pr', 'merge', 'close'].includes(stage)) {
        const expected = {
          repository: record.issue.repository,
          repositoryId: record.issue.repositoryId,
          id: pr.node_id,
          number: pr.number,
          head: pr.head.sha,
          base: pr.base.sha,
          workflows: pinned.ciWorkflows,
          reviewers: pinned.reviewers,
          ruleset: pinned.approval.ruleset,
          includeSources: stage === 'review-pr',
        };
        if (stage === 'close') {
          const prior = await store.get(receipts.merge?.artifacts.ciHash);
          expected.mergedCommit = receipts.merge.artifacts.mergeCommit;
          expected.admittedCI = prior;
          expected.base = prior.base;
          context.pr.base = prior.base;
          requireThat(isSha(prior.testMerge), 'ORIGINAL_TEST_MERGE_REQUIRED');
          expected.testMerge = prior.testMerge;
          context.pr.mergePreview = prior.testMerge;
          expected.workflows = expected.workflows.map((pin) => ({
            ...pin,
            targetSha: prior.checks.find((check) => check.name === pin.context)
              ?.targetSha,
          }));
        }
        context.ci = await readPullRequestCI(reader, expected, clock());
      }
    }
    context.isolation = await inspectIsolation(stage, {
      issue: record.issue,
      execution: actor,
      runner,
    });
    return context;
  };
}
