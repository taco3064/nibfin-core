import { observeWorkEligibility } from './work-eligibility.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { readCurrentMain } from './current-main.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readPullRequestCI } from './github-ci.mjs';
import { ciLogsWaiting, requiredCheckFailed } from './ci-recovery.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { evidenceBinding, stages } from './stages.mjs';
import { equivalentCandidate } from './candidate-evidence.mjs';
import { repoPath } from './github-read.mjs';
import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { readAdoptedOpenPr } from './adopt-open-pr.mjs';
import { deliveryLifecycle, matchesDeliveryCheckpoint, readDeliveryCheckpoint }
  from './delivery-checkpoint.mjs';

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
  observeSharedCaller,
  hostMain,
  localCommit,
  observeResult,
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
    const nativePolicy = pinned.approval.kind === 'repository-admission-v1';
    const eligibility = await observeWorkEligibility(reader, pinned, approval);
    const stateBinding = pinned.stateBinding;
    const store = stores(evidenceBinding({ approval, stateBinding })),
      receipts = await store.load();
    const main = await readCurrentMain(
      reader, record.issue, hostMain, approval.repository,
    );
    const context = {
      approval,
      ...(stateBinding ? { stateBinding } : {}),
      main,
      ...eligibility,
      receipts,
      execution: actor,
    };
    if (receipts.shape?.outcome === 'ready') {
      const body = await store.get(receipts.shape.artifacts.shapeHash);
      context.shape = { body, hash: digest(body) };
    }
    if (receipts.deliver?.artifacts.candidateHash &&
      receipts.deliver.artifacts.shapeHash === context.shape?.hash)
      context.candidate = await store.get(receipts.deliver.artifacts.candidateHash)
        .catch(error => {
          if (stage === 'deliver' && !receipts['commit-pr'] && error.code === 'ENOENT')
            return undefined;
          throw error;
        });
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
    const beforePublication = ['pre-accept-hooks', 'accept', 'post-accept-hooks',
      'commit-pr'].includes(stage);
    if (beforePublication &&
        receipts.deliver?.outcome === 'ready' && !receipts['commit-pr']) {
      const checkpoint = receipts.deliver.deliveryCheckpoint &&
        await readDeliveryCheckpoint(reader, record.issue,
          { shape: context.shape.body, lifecycle: deliveryLifecycle(context) });
      requireThat(context.candidate && !checkpoint?.mergedPublication &&
        matchesDeliveryCheckpoint(checkpoint, context.candidate),
        'DELIVER_CHECKPOINT_REQUIRED');
    }
    if (stage === 'deliver' && pinned.openPr && !context.candidate &&
      !receipts['commit-pr']) {
      const adopted = await readAdoptedOpenPr(reader, record.issue, pinned.openPr,
        record.roles.publisher, { ignoreAbandoned: true });
      const handoff = pinned.openPr.localCandidate;
      if (adopted && handoff) {
        requireThat(handoff.issueId === record.issue.id &&
          handoff.shapeHash === context.shape?.hash &&
          typeof handoff.workspace === 'string' &&
          /^workspace-[a-f0-9]{64}$/.test(handoff.workspace),
        'INVALID_HANDOFF_WORKSPACE');
      }
      if (adopted) context.adoptedCandidate = handoff
        ? { ...handoff, number: pinned.openPr.number } : pinned.openPr;
    }
    if (stage === 'deliver') context.rebaseTarget = main.head;
    if (stage === 'commit-pr' && pinned.openPr &&
      receipts['commit-pr']?.outcome !== 'published') {
      context.pr = await readAdoptedOpenPr(reader, record.issue, pinned.openPr,
        record.roles.publisher, { ignoreAbandoned: true });
      if (context.pr) context.adoptedOpenPr = true;
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
      const commit = await localCommit?.(pr.head.sha) ??
        await reader.get(`${root}/git/commits/${pr.head.sha}`);
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
      let resumeCICorrection = false;
      if (stage === 'deliver' && !context.candidate &&
        receipts.deliver?.outcome === 'blocked' &&
        pr.state === 'open' && pr.head.sha === saved.head &&
        commit.tree.sha === published.tree &&
        saved.shapeHash === context.shape?.hash) {
        // The PR still matches publication; Deliver captures any retained local edits.
        context.candidate = published;
        context.rebaseTarget = main.head;
        resumeCICorrection = !pinned.ciFailure && pr.merged === false &&
          receipts.deliver.blockedCICorrection === true && pr.base.sha === main.head;
      }
      if (stage === 'deliver' && pinned.ciFailure) {
        const failure = pinned.ciFailure;
        requireThat(
          pr.state === 'open' && pr.merged === false &&
            failure.number === pr.number && failure.head === pr.head.sha &&
            failure.base === pr.base.sha && failure.base === main.head &&
            saved.candidateHash === receipts.deliver?.artifacts.candidateHash,
          'CI_REPAIR_TARGET_CHANGED',
        );
        context.ciFailure = failure;
      }
      if (resumeCICorrection || ['review-pr', 'merge', 'close'].includes(stage)) {
        const expected = {
          repository: record.issue.repository,
          repositoryId: record.issue.repositoryId,
          id: pr.node_id,
          number: pr.number,
          head: pr.head.sha,
          base: pr.base.sha,
          workflows: nativePolicy ? (pinned.ciWorkflows ?? []) : pinned.ciWorkflows,
          reviewers: nativePolicy ? [] : pinned.reviewers,
          ruleset: pinned.approval.ruleset,
          nativePolicy,
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
        if (stage === 'review-pr') context.checkObservations = [];
        // A check observation may return an actionable wait without a receipt.
        observeResult?.(context);
        const ci = await readPullRequestCI(reader, expected, clock(), {
          repository: approval.repository, pr,
          checkObservations: context.checkObservations,
        }).catch(error => {
          if (!resumeCICorrection || error.code !== requiredCheckFailed) throw error;
          if (error.failure.logsUnavailable)
            throw Object.assign(new Error(ciLogsWaiting), { code: ciLogsWaiting });
          context.ciFailure = error.failure;
          return null;
        });
        if (!resumeCICorrection) context.ci = ci;
      }
    }
    // A pending CI observation needs no Runner or isolation check. Any stage
    // which can proceed still revalidates both before the journal admits it.
    const runner = await readRunnerBinding(reader, pinned.runner, observeSharedCaller);
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
    Object.assign(context, { runner, source,
      ...(pinned.continuation === true ? {
        publicationExecution: structuredClone(pinned.runner),
      } : {}) });
    context.isolation = await inspectIsolation(stage, {
      issue: record.issue,
      execution: actor,
      runner,
    });
    observeResult?.(context);
    return context;
  };
}
