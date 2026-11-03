import { repoPath } from './github-read.mjs';
import { digest, gitBlob, isId, isSha, isDigest, requireThat } from './identity.mjs';
import { validateApprovalRecord } from './approval-record.mjs';

// A deliberately narrow first adapter: merged, same-repository approval PRs
// targeting a classic protected default branch. Rulesets-only and additional
// effective rules are unsupported, never silently treated as classic policy.
export function checkProtection(policy) {
  const reviews = policy?.required_pull_request_reviews;
  const checks = policy?.required_status_checks;
  requireThat(policy?.enforce_admins?.enabled === true && policy.allow_force_pushes?.enabled === false &&
    policy.allow_deletions?.enabled === false, 'UNENFORCED_PROTECTION');
  requireThat(reviews?.require_code_owner_reviews === false, 'CODEOWNERS_ADAPTER_REQUIRED');
  const count = reviews?.required_approving_review_count;
  requireThat(Number.isSafeInteger(count) && count >= 0 && count <= 6 &&
    (count === 0 ? reviews.require_last_push_approval === false :
      reviews.dismiss_stale_reviews === true && reviews.require_last_push_approval === true), 'INSUFFICIENT_REVIEW_PROTECTION');
  const bypass = reviews.bypass_pull_request_allowances;
  requireThat(bypass === undefined || (['users', 'teams', 'apps'].every(key => Array.isArray(bypass[key]) &&
    bypass[key].length === 0) && Object.keys(bypass).every(key => ['users', 'teams', 'apps'].includes(key))), 'BYPASS_ALLOWED');
  requireThat(checks?.strict === true && Array.isArray(checks.checks) && checks.checks.length > 0 &&
    checks.checks.every(check => typeof check.context === 'string' && check.context.trim() && isId(check.app_id)) &&
    new Set(checks.checks.map(check => check.context)).size === checks.checks.length, 'UNBOUND_REQUIRED_CHECKS');
  requireThat(Array.isArray(checks.contexts) && checks.contexts.length === checks.checks.length &&
    checks.contexts.every(context => checks.checks.some(check => check.context === context)) &&
    new Set(checks.contexts).size === checks.contexts.length, 'UNBOUND_REQUIRED_CHECKS');
  return policy;
}

export async function readMemberPermission(reader, repository, user) {
  requireThat(isId(user?.id) && user.type === 'User' && typeof user.login === 'string' &&
    /^[A-Za-z0-9-]+$/.test(user.login), 'INVALID_MEMBER');
  const result = await reader.get(`${repoPath(repository)}/collaborators/${encodeURIComponent(user.login)}/permission`);
  requireThat(result?.user?.id === user.id && result.user.login === user.login && result.user.type === 'User' &&
    ['write', 'admin'].includes(result.permission), 'MEMBER_PERMISSION_REVOKED');
  return { id: user.id, login: user.login, permission: result.permission };
}

export async function readReviewers(reader, root, repository, pr, policy, permitted, now) {
  const reviews = await reader.list(`${root}/pulls/${pr.number}/reviews`);
  const ids = new Set(), latest = new Map();
  for (const review of reviews) {
    requireThat(isId(review.id) && !ids.has(review.id) && isId(review.user?.id) &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(review.state), 'INVALID_REVIEW');
    ids.add(review.id);
    if (review.state === 'PENDING') continue;
    const submitted = Date.parse(review.submitted_at);
    requireThat(Number.isFinite(submitted) && submitted <= now, 'INVALID_REVIEW_TIME');
    if (review.state === 'COMMENTED') continue;
    const previous = latest.get(review.user.id);
    if (!previous || submitted > Date.parse(previous.submitted_at) ||
      submitted === Date.parse(previous.submitted_at) && review.id > previous.id) latest.set(review.user.id, review);
  }
  const approved = [];
  for (const review of latest.values()) {
    requireThat(review.state !== 'CHANGES_REQUESTED', 'CHANGES_REQUESTED');
    if (review.state !== 'APPROVED') continue;
    if (pr.merged === true) requireThat(Date.parse(review.submitted_at) <= Date.parse(pr.merged_at), 'POST_MERGE_APPROVAL');
    // A stale approval may not contribute even if a provider response claims clean.
    requireThat(review.commit_id === pr.head.sha, 'STALE_REVIEW');
    if (review.user.id === pr.user.id || !permitted.includes(review.user.id)) continue;
    approved.push({ reviewId: review.id, submittedAt: review.submitted_at,
      ...await readMemberPermission(reader, repository, review.user) });
  }
  requireThat(approved.length >= policy.required_pull_request_reviews.required_approving_review_count,
    'INDEPENDENT_APPROVAL_REQUIRED');
  return { reviews, approved: approved.sort((a, b) => a.id - b.id) };
}

export async function readPinnedFile(reader, repository, path, ref, expectedBlob) {
  requireThat(typeof path === 'string' && path && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git') &&
    isSha(ref) && isSha(expectedBlob), 'INVALID_PINNED_FILE');
  const file = await reader.get(`${repoPath(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);
  requireThat(file?.type === 'file' && file.path === path && file.sha === expectedBlob && file.encoding === 'base64' &&
    typeof file.content === 'string' && isId(file.size) && file.size <= 1024 * 1024, 'PINNED_FILE_UNAVAILABLE');
  const encoded = file.content.replace(/\n/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  requireThat(bytes.toString('base64') === encoded && bytes.length === file.size && gitBlob(bytes) === expectedBlob,
    'PINNED_FILE_IDENTITY_MISMATCH');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// pin must come from trusted installation/adoption, never Issue/event/Agent input.
// A merged approval record remains usable without per-stage human approval.
// Editing/deleting/restoring its file, changing policy, dismissing review or
// revoking a reviewer invalidates this evidence. This reader provides
// approval provenance ONLY: CI source, stage/Runner/job/isolation and current
// Scope/Shape/dependencies are separate mandatory admission checks.
export async function readProtectedApproval(reader, pin, now = Date.now()) {
  requireThat(isId(pin?.repositoryId) && isId(pin.prNumber) && typeof pin.prId === 'string' &&
    isSha(pin.head) && isSha(pin.base) && isSha(pin.merge) && isId(pin.ruleSuiteId) && isDigest(pin.recordHash) && isDigest(pin.protectionHash) &&
    Array.isArray(pin.reviewers) && pin.reviewers.every(isId) &&
    new Set(pin.reviewers).size === pin.reviewers.length && Number.isSafeInteger(now), 'INVALID_APPROVAL_PIN');
  const root = repoPath(pin.repository);
  const readRepository = async () => {
    const repository = await reader.repository(pin.repository);
    requireThat(repository?.id === pin.repositoryId && repository.full_name === pin.repository && repository.private === false &&
      repository.archived === false && repository.disabled === false && ['User', 'Organization'].includes(repository.owner?.type) &&
      typeof repository.default_branch === 'string' && repository.default_branch, 'REPOSITORY_IDENTITY_CHANGED');
    return repository;
  };
  const repository = await readRepository();
  const branch = encodeURIComponent(repository.default_branch);
  const protectionPath = `${root}/branches/${branch}/protection`;
  const policy = checkProtection(await reader.get(protectionPath));
  requireThat(digest(policy) === pin.protectionHash, 'PROTECTION_CHANGED');
  const effectiveRules = await reader.list(`${root}/rules/branches/${branch}`);
  requireThat(effectiveRules.length === 0, 'UNSUPPORTED_EFFECTIVE_RULES');
  const branchState = await reader.get(`${root}/branches/${branch}`);
  requireThat(branchState?.protected === true && isSha(branchState.commit?.sha), 'APPROVAL_BASE_CHANGED');
  const prPath = `${root}/pulls/${pin.prNumber}`;
  const pr = await reader.get(prPath);
  requireThat(pr?.node_id === pin.prId && pr.number === pin.prNumber && pr.state === 'closed' && pr.draft === false &&
    pr.merged === true && pr.merge_commit_sha === pin.merge && isId(pr.merged_by?.id) &&
    Number.isFinite(Date.parse(pr.merged_at)) && Date.parse(pr.merged_at) <= now && isId(pr.user?.id) && pr.user.type === 'User' &&
    pr.head?.sha === pin.head && pr.head.repo?.id === pin.repositoryId && pr.head.repo.full_name === pin.repository &&
    pr.base?.sha === pin.base && pr.base.ref === repository.default_branch && pr.base.repo?.id === pin.repositoryId &&
    pr.base.repo.full_name === pin.repository, 'APPROVAL_PR_CHANGED_OR_BLOCKED');
  const merge = await reader.get(`${root}/git/commits/${pin.merge}`);
  requireThat(merge.sha === pin.merge && Array.isArray(merge.parents) && merge.parents.length === 2 &&
    merge.parents[0].sha === pin.base && merge.parents[1].sha === pin.head, 'UNSUPPORTED_APPROVAL_MERGE');
  const suitePath = `${root}/rulesets/rule-suites/${pin.ruleSuiteId}`;
  const suite = await reader.get(suitePath);
  requireThat(suite?.id === pin.ruleSuiteId && suite.repository_id === pin.repositoryId &&
    suite.before_sha === pin.base && suite.after_sha === pin.merge && suite.ref === `refs/heads/${repository.default_branch}` &&
    suite.actor_id === pr.merged_by.id && suite.result === 'pass' && suite.evaluation_result === 'pass' &&
    Array.isArray(suite.rule_evaluations) && suite.rule_evaluations.length > 0 &&
    suite.rule_evaluations.every(rule => rule.enforcement === 'active' && rule.result === 'pass' && rule.rule_source?.type === 'protected_branch') &&
    ['pull_request', 'required_status_checks'].every(type => suite.rule_evaluations.some(rule => rule.rule_type === type)),
  'MISSING_OR_BYPASSED_MERGE_ENFORCEMENT');
  const comparison = await reader.get(`${root}/compare/${pin.merge}...${branchState.commit.sha}`);
  requireThat(['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === pin.merge, 'APPROVAL_MERGE_NOT_ANCESTOR');
  requireThat(pin.path === `.nibfin/approvals/${pin.issueId}.json`, 'APPROVAL_PATH_MISMATCH');
  const body = await readPinnedFile(reader, pin.repository, pin.path, pin.head, pin.blob);
  await readPinnedFile(reader, pin.repository, pin.path, pin.merge, pin.blob);
  await readPinnedFile(reader, pin.repository, pin.path, branchState.commit.sha, pin.blob);
  const latestChange = async ref => {
    const commits = await reader.get(`${root}/commits?sha=${ref}&path=${encodeURIComponent(pin.path)}&per_page=1`);
    requireThat(Array.isArray(commits) && commits.length === 1 && isSha(commits[0].sha), 'APPROVAL_FILE_HISTORY_UNAVAILABLE');
    return commits[0].sha;
  };
  requireThat(await latestChange(pin.merge) === await latestChange(branchState.commit.sha), 'APPROVAL_REVOKED_OR_SUPERSEDED');
  const record = validateApprovalRecord(JSON.parse(body), now);
  requireThat(record.issue.id === pin.issueId && record.issue.repositoryId === pin.repositoryId &&
    record.issue.repository === pin.repository && digest(record) === pin.recordHash &&
    digest(record.source) === digest(pin.source), 'APPROVAL_RECORD_CHANGED');
  requireThat(pr.merged_by.id === record.roles.publisher, 'APPROVAL_PUBLISHER_MISMATCH');
  const publisher = await readMemberPermission(reader, pin.repository, pr.merged_by);
  if (policy.required_pull_request_reviews.required_approving_review_count === 0) {
    // Solo authority is the actual repository Owner's protected merge, never a
    // synthetic human Approve. Agent role/session validation stays independent.
    requireThat(repository.owner?.type === 'User' && isId(repository.owner.id) &&
      repository.owner.id === pr.merged_by.id && publisher.permission === 'admin', 'SOLO_OWNER_MERGE_REQUIRED');
  }
  const independent = pin.reviewers.filter(id => id !== record.roles.author && id !== record.roles.writer);
  const reviewers = await readReviewers(reader, root, pin.repository, pr, policy, independent, now);
  // Bracket reads detect races; they do not create an atomic transaction with
  // GitHub. Runtime must re-read immediately at every protected boundary.
  requireThat(digest(await reader.get(prPath)) === digest(pr) &&
    digest(await reader.get(protectionPath)) === digest(policy) &&
    digest(await reader.get(suitePath)) === digest(suite) &&
    digest(await reader.list(`${root}/pulls/${pin.prNumber}/reviews`)) === digest(reviewers.reviews) &&
    digest(await reader.get(`${root}/branches/${branch}`)) === digest(branchState) &&
    (await reader.list(`${root}/rules/branches/${branch}`)).length === 0 &&
    (await readRepository()).default_branch === repository.default_branch, 'APPROVAL_CHANGED_DURING_READ');
  return { record, approvalHash: digest({ pin, reviews: reviewers.approved }), reviewers: reviewers.approved,
    requiredChecks: policy.required_status_checks.checks, pullRequest: { id: pin.prId, number: pin.prNumber, head: pin.head, base: pin.base } };
}
