import { repoPath } from './github-read.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { checkProtection, readPinnedFile, readReviewers } from './github-approval.mjs';
import { readMergeIdentity } from './github-merge.mjs';

// Only the pinned, reviewed workflow's first checkout step may establish this
// observation. Native step timing and the first exact checkout log marker bound
// the region before any candidate test command runs. Logs alone grant nothing.
export function checkoutIdentity(logs, step) {
  requireThat(typeof logs === 'string' && step?.number === 2 && step.status === 'completed' && step.conclusion === 'success', 'CHECKOUT_STEP_REQUIRED');
  const start = Date.parse(step.started_at), end = Date.parse(step.completed_at);
  requireThat(Number.isFinite(start) && Number.isFinite(end) && start <= end, 'INVALID_CHECKOUT_TIMING');
  const lines = logs.split('\n').map(line => /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)\r?$/.exec(line)).filter(Boolean)
    .filter(line => Date.parse(line[1]) >= start && Date.parse(line[1]) < end + 1000);
  const markers = lines.map((line, index) => ({ line, index })).filter(({ line }) =>
    /^\[command\]\/usr\/bin\/git log -1 --format=%H\r?$/.test(line[2]));
  requireThat(markers.length === 1, 'AMBIGUOUS_CHECKOUT_LOG');
  const sha = lines[markers[0].index + 1]?.[2].trim();
  requireThat(isSha(sha), 'CHECKOUT_SHA_UNAVAILABLE');
  return sha;
}

// trusted pins declare a reviewed checkout recipe: first user-code-bearing step
// is checkout (step 2), pinned actions/checkout, no untrusted commands before it.
// Unsupported recipes, status contexts and self-hosted CI fail closed.
export async function readPullRequestCI(reader, expected, now = Date.now()) {
  requireThat(isId(expected?.repositoryId) && isId(expected.number) && typeof expected.id === 'string' &&
    isSha(expected.head) && isSha(expected.base) && Array.isArray(expected.workflows) && expected.workflows.length > 0 &&
    expected.workflows.every(pin => isId(pin.appId) && isId(pin.workflowId) && isSha(pin.blob) &&
      /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(pin.path) && pin.checkoutStep === 2 &&
      /^Run actions\/checkout@[a-f0-9]{40}$/.test(pin.checkoutName) && typeof pin.context === 'string' && pin.context.trim()) &&
    new Set(expected.workflows.map(pin => pin.context)).size === expected.workflows.length &&
    Array.isArray(expected.reviewers) && expected.reviewers.every(isId), 'INVALID_CI_PIN');
  const root = repoPath(expected.repository), prPath = `${root}/pulls/${expected.number}`;
  const repository = await reader.repository(expected.repository);
  requireThat(repository.id === expected.repositoryId && repository.full_name === expected.repository && repository.private === false,
    'CI_REPOSITORY_CHANGED');
  const pr = await reader.get(prPath);
  const merged = expected.mergedCommit !== undefined;
  if (merged) requireThat(isSha(expected.mergedCommit) && isSha(expected.testMerge) &&
    expected.admittedCI?.prId === expected.id && expected.admittedCI.head === expected.head &&
    expected.admittedCI.base === expected.base && expected.admittedCI.testMerge === expected.testMerge &&
    expected.workflows.every(pin => isSha(pin.targetSha) && [expected.head, expected.testMerge].includes(pin.targetSha)), 'INVALID_CLOSURE_CI_PIN');
  const previewSha = merged ? expected.testMerge : pr.merge_commit_sha;
  requireThat(pr.node_id === expected.id && pr.number === expected.number && (merged ? pr.state === 'closed' && pr.merged === true && pr.merge_commit_sha === expected.mergedCommit : pr.state === 'open') && pr.draft === false &&
    pr.head?.sha === expected.head && pr.head.repo?.id === expected.repositoryId && pr.base?.sha === expected.base &&
    pr.base.repo?.id === expected.repositoryId && pr.base.ref === repository.default_branch &&
    (merged || pr.mergeable === true && pr.mergeable_state === 'clean') && isSha(previewSha), 'CI_PR_NOT_ELIGIBLE');
  const branchPath = `${root}/branches/${encodeURIComponent(pr.base.ref)}`;
  const branch = await reader.get(branchPath);
  requireThat(branch.protected === true && isSha(branch.commit?.sha), 'CI_BASE_CHANGED');
  if (merged) {
    await readMergeIdentity(reader, root, { head: expected.head, base: expected.base, merge: expected.mergedCommit }, 'MERGED_CONTENT_CHANGED');
    const ancestry = await reader.get(`${root}/compare/${expected.mergedCommit}...${branch.commit.sha}`);
    requireThat(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === expected.mergedCommit, 'MERGED_COMMIT_NOT_CURRENT_ANCESTOR');
  } else requireThat(branch.commit.sha === expected.base, 'CI_BASE_CHANGED');
  const policy = checkProtection(await reader.get(`${branchPath}/protection`));
  requireThat((await reader.list(`${root}/rules/branches/${encodeURIComponent(pr.base.ref)}`)).length === 0, 'UNSUPPORTED_EFFECTIVE_RULES');
  requireThat(policy.required_status_checks.checks.length === expected.workflows.length &&
    policy.required_status_checks.checks.every(check => expected.workflows.some(pin => pin.context === check.context && pin.appId === check.app_id)),
  'REQUIRED_CHECK_SOURCE_CHANGED');
  const reviewers = await readReviewers(reader, root, expected.repository, pr, policy, expected.reviewers, now);
  const preview = await reader.get(`${root}/git/commits/${previewSha}`);
  requireThat(preview.sha === previewSha && digest(preview.parents?.map(parent => parent.sha)) === digest([expected.base, expected.head]), 'INVALID_PROVIDER_TEST_MERGE');
  const headChecks = await reader.list(`${root}/commits/${expected.head}/check-runs?filter=latest`, 'check_runs');
  const mergeChecks = await reader.list(`${root}/commits/${previewSha}/check-runs?filter=latest`, 'check_runs');
  const checks = [], sources = [];
  let testedSha;
  for (const pin of expected.workflows) {
    const onMerge = merged && pin.targetSha === expected.head ? [] : mergeChecks.filter(check => check.name === pin.context && check.app?.id === pin.appId);
    if (merged && pin.targetSha === previewSha && previewSha !== expected.head) requireThat(onMerge.length > 0, 'MERGED_CHECK_EVIDENCE_MISSING');
    const candidates = onMerge.length ? onMerge : headChecks.filter(check => check.name === pin.context && check.app?.id === pin.appId);
    const matches = [];
    for (const check of candidates) {
      requireThat(isId(check.id) && isId(check.check_suite?.id), 'INVALID_CHECK_IDENTITY');
      const runs = await reader.list(`${root}/actions/runs?check_suite_id=${check.check_suite.id}`, 'workflow_runs');
      requireThat(runs.length === 1, 'AMBIGUOUS_CHECK_RUN_SOURCE');
      const run = runs[0];
      if (run.event !== 'pull_request') continue;
      requireThat(run.repository?.id === expected.repositoryId && run.head_repository?.id === expected.repositoryId &&
        run.head_sha === expected.head && run.workflow_id === pin.workflowId && run.path === pin.path &&
        run.check_suite_id === check.check_suite.id && isId(run.id) && isId(run.run_attempt) &&
        run.status === 'completed' && run.conclusion === 'success' && check.status === 'completed' && check.conclusion === 'success' &&
        check.head_sha === (onMerge.length ? previewSha : expected.head) &&
        Array.isArray(run.pull_requests) && ((merged && run.pull_requests.length === 0) ||
          run.pull_requests.some(link => link.number === expected.number &&
            link.head?.sha === expected.head && link.base?.sha === expected.base && link.head.repo?.id === expected.repositoryId && link.base.repo?.id === expected.repositoryId)),
      'CI_SOURCE_OR_RESULT_MISMATCH');
      const jobs = await reader.list(`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
      const matchingJobs = jobs.filter(job => job.check_run_url === `https://api.github.com${root}/check-runs/${check.id}`);
      requireThat(matchingJobs.length === 1, 'CI_JOB_BINDING_REQUIRED');
      const job = matchingJobs[0];
      requireThat(isId(job.id) && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === expected.head &&
        job.name === pin.context && job.status === 'completed' && job.conclusion === 'success' &&
        job.runner_group_name === 'GitHub Actions' && Array.isArray(job.labels) && !job.labels.includes('self-hosted'), 'UNTRUSTED_CI_JOB');
      const checkout = job.steps?.find(step => step.number === pin.checkoutStep);
      requireThat(checkout?.name === pin.checkoutName && job.steps.filter(step => step.number < 2).length === 1 &&
        job.steps[0].name === 'Set up job', 'UNTRUSTED_CHECKOUT_RECIPE');
      const actualSha = checkoutIdentity(await reader.jobLogs(expected.repository, job.id), checkout);
      requireThat([expected.head, previewSha].includes(actualSha) && (!onMerge.length || actualSha === previewSha), 'STALE_TESTED_SHA');
      requireThat(testedSha === undefined || testedSha === actualSha, 'MIXED_CHECKOUT_TARGETS'); testedSha = actualSha;
      await readPinnedFile(reader, expected.repository, pin.path, run.head_sha, pin.blob);
      await readPinnedFile(reader, expected.repository, pin.path, actualSha, pin.blob);
      const fresh = await reader.get(`${root}/actions/runs/${run.id}`);
      requireThat(fresh.run_attempt === run.run_attempt && fresh.status === 'completed' && fresh.conclusion === 'success' &&
        fresh.head_sha === expected.head && fresh.check_suite_id === run.check_suite_id, 'CI_RERUN_OR_REVOCATION');
      matches.push({ id: check.id, name: pin.context, targetSha: check.head_sha, appId: pin.appId, status: check.status, conclusion: check.conclusion, testedSha: actualSha });
      sources.push({ runId: run.id, attempt: run.run_attempt, jobId: job.id, workflowId: pin.workflowId, blob: pin.blob });
    }
    requireThat(matches.length === 1, 'MISSING_OR_AMBIGUOUS_REQUIRED_CHECK'); checks.push(matches[0]);
  }
  requireThat(digest(await reader.get(prPath)) === digest(pr) && digest(await reader.get(branchPath)) === digest(branch) &&
    digest(await reader.get(`${branchPath}/protection`)) === digest(policy) &&
    digest(await reader.list(`${root}/pulls/${expected.number}/reviews`)) === digest(reviewers.reviews) &&
    (await reader.list(`${root}/rules/branches/${encodeURIComponent(pr.base.ref)}`)).length === 0 &&
    digest(await reader.list(`${root}/commits/${expected.head}/check-runs?filter=latest`, 'check_runs')) === digest(headChecks) &&
    digest(await reader.list(`${root}/commits/${previewSha}/check-runs?filter=latest`, 'check_runs')) === digest(mergeChecks), 'CI_CHANGED_DURING_READ');
  const evidence = { prId: expected.id, head: expected.head, base: expected.base, testedSha, testMerge: previewSha,
    parents: testedSha === expected.head ? [] : [expected.base, expected.head], checks,
    protectionHash: digest(policy), provenanceHash: digest({ sources, reviewers: reviewers.approved }) };
  // GitHub may remove run-to-PR associations after merge. Only the exact CI
  // admitted before our merge may survive that loss; a new green run cannot.
  if (merged) requireThat(digest(evidence) === digest(expected.admittedCI), 'CLOSURE_CI_CHANGED');
  return evidence;
}
