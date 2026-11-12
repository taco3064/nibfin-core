import { isDeepStrictEqual } from 'node:util';
import { repoPath } from './github-read.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readReviewers } from './github-approval.mjs';
import { readProtection } from './github-protection.mjs';
import { readMergeIdentity } from './github-merge.mjs';
import { failedCheckError } from './ci-recovery.mjs';

const pendingObservations = Object.freeze([
  'MERGE_REOBSERVE_REQUIRED',
  'CI_BASE_CHANGED',
  'CI_CHANGED_DURING_READ',
  'CI_WAITING',
  'CI_REGISTRATION_PENDING',
  'PR_MERGEABILITY_PENDING',
]);
// These codes arise before an effect, after current PR/source/authority reads.
// Missing checks and unknown mergeability are not claims of observed running CI.
export const pendingCIObservation = (code) => pendingObservations.includes(code);

export const integrationRepairRequired = code =>
  code === 'PR_BRANCH_UPDATE_REQUIRED' || code === 'PR_MERGE_CONFLICT';

async function currentPullRequest(reader, prPath, branchPath, pr, branch) {
  const [current, target] = await Promise.all([
    reader.get(prPath), reader.get(branchPath),
  ]);
  return current.node_id === pr.node_id && current.state === pr.state &&
    current.draft === pr.draft && current.head?.sha === pr.head.sha &&
    current.base?.sha === pr.base.sha && current.base?.ref === pr.base.ref &&
    current.merge_commit_sha === pr.merge_commit_sha &&
    current.mergeable_state === pr.mergeable_state &&
    target.commit?.sha === branch.commit.sha;
}

async function workflowBlob(reader, root, path, ref) {
  const file = await reader.get(`${root}/contents/${path}?ref=${ref}`);
  requireThat(file?.type === 'file' && file.path === path && isSha(file.sha),
    'CI_WORKFLOW_SOURCE_UNAVAILABLE');
  return file.sha;
}

// Use GitHub's required check and its PR run. The protected base supplies the
// current Workflow source so a Candidate cannot substitute its own CI recipe.
async function nativeRequiredWorkflows(reader, branchPath, root, pr, workflows) {
  if (pr.mergeable_state !== 'blocked' || !workflows.length) return [];
  // This lookup only enables correction of recognizable CI failures.
  // GitHub still decides whether the PR can merge.
  const [classic, rules] = await Promise.all([
    reader.get(branchPath + '/protection').catch(() => null),
    reader.list(root + '/rules/branches/' + encodeURIComponent(pr.base.ref))
      .catch(() => []),
  ]);
  const checks = [
    ...(classic?.required_status_checks?.checks ?? []),
    ...rules.filter(rule => rule.type === 'required_status_checks').flatMap(rule =>
      (rule.parameters?.required_status_checks ?? []).map(check => ({
        context: check.context, app_id: check.integration_id,
      }))),
  ];
  return workflows.filter(workflow => checks.some(check =>
    check.context === workflow.context &&
    (check.app_id == null || check.app_id === -1 || check.app_id === workflow.appId)));
}

export async function readPullRequestCI(reader, expected, now = Date.now()) {
  const nativePolicy = expected?.nativePolicy === true;
  requireThat(
    isId(expected?.repositoryId) &&
      isId(expected.number) &&
      typeof expected.id === 'string' &&
      isSha(expected.head) &&
      isSha(expected.base) &&
      Array.isArray(expected.workflows) &&
      (nativePolicy || expected.workflows.length > 0) &&
      expected.workflows.every(
        (pin) =>
          isId(pin.appId) &&
          isId(pin.workflowId) &&
          /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(pin.path) &&
          typeof pin.context === 'string' &&
          pin.context.trim(),
      ) &&
      new Set(expected.workflows.map((pin) => pin.context)).size ===
        expected.workflows.length &&
      Array.isArray(expected.reviewers) &&
      expected.reviewers.every(isId),
    'INVALID_CI_PIN',
  );
  const root = repoPath(expected.repository),
    prPath = `${root}/pulls/${expected.number}`;
  const repository = await reader.repository(expected.repository);
  requireThat(
    repository.id === expected.repositoryId &&
      repository.full_name === expected.repository &&
      repository.private === false,
    'CI_REPOSITORY_CHANGED',
  );
  const pr = await reader.get(prPath);
  const merged = expected.mergedCommit !== undefined;
  if (merged)
    requireThat(
      isSha(expected.mergedCommit) &&
        isSha(expected.testMerge) &&
        expected.admittedCI?.prId === expected.id &&
        expected.admittedCI.head === expected.head &&
        expected.admittedCI.base === expected.base &&
        expected.admittedCI.testMerge === expected.testMerge &&
        (nativePolicy || expected.workflows.every(
          (pin) =>
            isSha(pin.targetSha) &&
            [expected.head, expected.testMerge].includes(pin.targetSha),
        )),
      'INVALID_CLOSURE_CI_PIN',
    );
  const previewSha = merged ? expected.testMerge : pr.merge_commit_sha;
  requireThat(
    pr.node_id === expected.id &&
      pr.number === expected.number &&
      (merged
        ? pr.state === 'closed' &&
          pr.merged === true &&
          pr.merge_commit_sha === expected.mergedCommit
        : pr.state === 'open') &&
      pr.draft === false &&
      pr.head?.sha === expected.head &&
      pr.head.repo?.id === expected.repositoryId &&
      (merged || pr.base?.sha === expected.base) &&
      pr.base.repo?.id === expected.repositoryId &&
      pr.base.ref === repository.default_branch &&
      (merged || pr.merged === false),
    'CI_PR_NOT_ELIGIBLE',
  );
  if (!merged) {
    requireThat(pr.mergeable_state !== 'behind', 'PR_BRANCH_UPDATE_REQUIRED');
    requireThat(pr.mergeable !== false, 'PR_MERGE_CONFLICT');
    requireThat(pr.mergeable === null || pr.mergeable === true &&
      (nativePolicy || ['clean', 'blocked', 'unstable'].includes(pr.mergeable_state)),
    'CI_PR_NOT_ELIGIBLE');
  }
  requireThat(isSha(previewSha) || (!merged && pr.mergeable === null &&
    previewSha === null), 'CI_PR_NOT_ELIGIBLE');
  const branchPath = `${root}/branches/${encodeURIComponent(pr.base.ref)}`;
  const branch = await reader.get(branchPath);
  requireThat((nativePolicy || branch.protected === true) && isSha(branch.commit?.sha),
    'CI_PROTECTION_UNAVAILABLE');
  if (merged) {
    await readMergeIdentity(
      reader,
      root,
      { head: expected.head, base: expected.base, merge: expected.mergedCommit,
        testMerge: expected.testMerge },
      'MERGED_CONTENT_CHANGED',
    );
    const ancestry = await reader.get(
      `${root}/compare/${expected.mergedCommit}...${branch.commit.sha}`,
    );
    requireThat(
      ['ahead', 'identical'].includes(ancestry.status) &&
        ancestry.merge_base_commit?.sha === expected.mergedCommit,
      'MERGED_COMMIT_NOT_CURRENT_ANCESTOR',
    );
    return expected.admittedCI;
  }
  requireThat(branch.commit.sha === expected.base, 'CI_BASE_CHANGED');
  const protection = nativePolicy ? null : await readProtection(
    reader,
    expected.repository,
    pr.base.ref,
    expected.ruleset,
  );
  const policy = protection?.policy;
  if (policy) requireThat(
    policy.required_status_checks.checks.length === expected.workflows.length &&
      policy.required_status_checks.checks.every((check) =>
        expected.workflows.some(
          (pin) => pin.context === check.context && pin.appId === check.app_id,
        ),
      ),
    'REQUIRED_CHECK_SOURCE_CHANGED',
  );
  const reviewers = policy ? await readReviewers(
    reader,
    root,
    expected.repository,
    pr,
    policy,
    expected.reviewers,
    now,
  ) : { approved: [] };
  if (pr.mergeable === null) requireThat(false, 'PR_MERGEABILITY_PENDING');
  const preview = await reader.get(`${root}/git/commits/${previewSha}`);
  requireThat(
    preview.sha === previewSha &&
      preview.parents?.length === 2 && preview.parents[0].sha === expected.base &&
      preview.parents[1].sha === expected.head,
    'INVALID_PROVIDER_TEST_MERGE',
  );
  const headChecks = await reader.list(
    `${root}/commits/${expected.head}/check-runs?filter=latest`,
    'check_runs',
  );
  const mergeChecks = await reader.list(
    `${root}/commits/${previewSha}/check-runs?filter=latest`,
    'check_runs',
  );
  const workflows = nativePolicy
    ? await nativeRequiredWorkflows(reader, branchPath, root, pr, expected.workflows)
    : expected.workflows;
  const checks = [],
    sources = [];
  let testedSha, unsuccessfulRun = false;
  for (const pin of workflows) {
    const onMerge = mergeChecks.filter(
      (check) => check.name === pin.context && check.app?.id === pin.appId,
    );
    const candidates = onMerge.length
      ? onMerge
      : headChecks.filter(
          (check) => check.name === pin.context && check.app?.id === pin.appId,
        );
    if (candidates.length === 0) requireThat(false, 'CI_REGISTRATION_PENDING');
    const matches = [];
    for (const check of candidates) {
      requireThat(
        isId(check.id) && isId(check.check_suite?.id),
        'INVALID_CHECK_IDENTITY',
      );
      const runs = await reader.list(
        `${root}/actions/runs?check_suite_id=${check.check_suite.id}`,
        'workflow_runs',
      );
      requireThat(runs.length === 1, 'AMBIGUOUS_CHECK_RUN_SOURCE');
      const run = runs[0];
      if (run.event !== 'pull_request') continue;
      const failed = ['failure', 'timed_out'].includes(check.conclusion);
      const checkPending =
        ['queued', 'in_progress', 'waiting', 'pending'].includes(check.status) &&
        check.conclusion === null;
      const checkFinished = check.status === 'completed' &&
        (check.conclusion === 'success' || failed);
      if (
        run.repository?.id === expected.repositoryId &&
        run.head_repository?.id === expected.repositoryId &&
        run.head_sha === expected.head &&
        run.workflow_id === pin.workflowId &&
        run.path === pin.path &&
        run.check_suite_id === check.check_suite.id &&
        ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status) &&
        check.head_sha === (onMerge.length ? previewSha : expected.head) &&
        run.conclusion === null &&
        (checkPending || checkFinished)
      )
        requireThat(false, 'CI_WAITING');
      requireThat(
        run.repository?.id === expected.repositoryId &&
          run.head_repository?.id === expected.repositoryId &&
          run.head_sha === expected.head &&
          run.workflow_id === pin.workflowId &&
          run.path === pin.path &&
          run.check_suite_id === check.check_suite.id &&
          isId(run.id) &&
          isId(run.run_attempt) &&
          run.status === 'completed' &&
          (run.conclusion === 'success' ||
            ['failure', 'timed_out'].includes(run.conclusion)) &&
          check.status === 'completed' &&
          (check.conclusion === 'success' || failed && run.conclusion !== 'success') &&
          check.head_sha === (onMerge.length ? previewSha : expected.head) &&
          Array.isArray(run.pull_requests) &&
          run.pull_requests.some(
              (link) =>
                link.number === expected.number &&
                link.head?.sha === expected.head &&
                link.base?.sha === expected.base &&
                link.head.repo?.id === expected.repositoryId &&
                link.base.repo?.id === expected.repositoryId,
            ),
        'CI_SOURCE_OR_RESULT_MISMATCH',
      );
      const jobs = await reader.list(
        `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
        'jobs',
      );
      const matchingJobs = jobs.filter(
        (job) =>
          job.check_run_url === `https://api.github.com${root}/check-runs/${check.id}`,
      );
      requireThat(matchingJobs.length === 1, 'CI_JOB_BINDING_REQUIRED');
      const job = matchingJobs[0];
      requireThat(
        isId(job.id) &&
          job.run_id === run.id &&
          job.run_attempt === run.run_attempt &&
          job.head_sha === expected.head &&
          job.name === pin.context &&
          job.status === 'completed' &&
          job.conclusion === check.conclusion &&
          job.runner_group_name === 'GitHub Actions' &&
          Array.isArray(job.labels) &&
          !job.labels.includes('self-hosted'),
        'UNTRUSTED_CI_JOB',
      );
      const [baseBlob, headBlob] = await Promise.all([
        workflowBlob(reader, root, pin.path, expected.base),
        workflowBlob(reader, root, pin.path, expected.head),
      ]);
      requireThat(baseBlob === headBlob, 'CI_WORKFLOW_CHANGED_BY_PR');
      const actualSha = check.head_sha;
      requireThat([expected.head, previewSha].includes(actualSha) &&
        (testedSha === undefined || testedSha === actualSha), 'MIXED_CHECKOUT_TARGETS');
      testedSha = actualSha;
      const fresh = await reader.get(`${root}/actions/runs/${run.id}`);
      requireThat(
        fresh.run_attempt === run.run_attempt &&
          fresh.status === 'completed' &&
          fresh.conclusion === run.conclusion &&
          fresh.head_sha === expected.head &&
          fresh.check_suite_id === run.check_suite_id,
        'CI_RERUN_OR_REVOCATION',
      );
      if (failed) {
        requireThat(candidates.length === 1, 'MISSING_OR_AMBIGUOUS_REQUIRED_CHECK');
        requireThat(
          await currentPullRequest(reader, prPath, branchPath, pr, branch),
          'CI_CHANGED_DURING_READ',
        );
        const logs = await reader.jobLogs(expected.repository, job.id).catch(() => '');
        throw failedCheckError(expected, run, job, logs);
      }
      unsuccessfulRun ||= run.conclusion !== 'success';
      matches.push({
        id: check.id,
        name: pin.context,
        targetSha: check.head_sha,
        appId: pin.appId,
        status: check.status,
        conclusion: check.conclusion,
        testedSha: actualSha,
      });
      sources.push({
        runId: run.id,
        attempt: run.run_attempt,
        jobId: job.id,
        workflowId: pin.workflowId,
        blob: baseBlob,
      });
    }
    requireThat(matches.length === 1, 'MISSING_OR_AMBIGUOUS_REQUIRED_CHECK');
    checks.push(matches[0]);
  }
  requireThat(!unsuccessfulRun, 'CI_SOURCE_OR_RESULT_MISMATCH');
  if (!nativePolicy) requireThat(pr.mergeable_state === 'clean', 'CI_PR_NOT_ELIGIBLE');
  const currentProtection = nativePolicy ? null : await readProtection(
    reader, expected.repository, pr.base.ref, expected.ruleset,
  );
  const currentReviewers = currentProtection ? await readReviewers(
    reader, root, expected.repository, pr, currentProtection.policy,
    expected.reviewers, now,
  ) : { approved: [] };
  requireThat(
    await currentPullRequest(reader, prPath, branchPath, pr, branch) &&
      currentProtection?.hash === protection?.hash &&
      isDeepStrictEqual(currentReviewers.approved, reviewers.approved),
    'CI_CHANGED_DURING_READ',
  );
  testedSha ??= expected.head;
  const evidence = {
    prId: expected.id,
    head: expected.head,
    base: expected.base,
    testedSha,
    testMerge: previewSha,
    parents: testedSha === expected.head ? [] : [expected.base, expected.head],
    checks,
    ...(protection ? { protectionHash: protection.hash } : {}),
    provenanceHash: digest({ sources, reviewers: reviewers.approved }),
    ...(expected.includeSources ? {
      sources: sources.map((source, index) => ({
        ...source,
        name: workflows[index].context,
        path: workflows[index].path,
      })),
      ...(nativePolicy ? { observedChecks: [...headChecks, ...mergeChecks].map(check => ({
        id: check.id, name: check.name, status: check.status,
        conclusion: check.conclusion,
      })) } : {}),
    } : {}),
  };
  return evidence;
}
