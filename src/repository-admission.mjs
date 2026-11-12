import { operations, validateApprovalRecord, validateIssueIdentity }
  from './approval-record.mjs';
import { issuePath } from './github-read.mjs';
import { digest, isId, requireThat } from './identity.mjs';

export function repositoryIssuePin(policy, issue) {
  validateIssueIdentity(issue);
  requireThat(
    policy.repository === issue.repository && policy.repositoryId === issue.repositoryId,
    'REPOSITORY_IDENTITY_CHANGED',
  );
  return { ...policy, issueId: issue.id, issueNumber: issue.number };
}

export function nativeEdgeIssue(edge, repository) {
  const issue = { ...repository, number: edge.number, id: edge.node_id };
  if (edge.pull_request || edge.url !== `https://api.github.com${issuePath(issue)}`)
    return null;
  return issue;
}

async function readPrerequisites(reader, issue) {
  return Promise.all((await reader.blockedBy(issue)).map(async (edge) => {
    const url = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/\d+$/;
    const match = url.exec(edge.url);
    requireThat(match, 'INVALID_NATIVE_PREREQUISITE');
    const repository = await reader.repository(match[1]);
    const prerequisite = nativeEdgeIssue(edge, {
      repository: repository.full_name, repositoryId: repository.id,
    });
    requireThat(prerequisite && repository.private === false,
      'INVALID_NATIVE_PREREQUISITE');
    return prerequisite;
  }));
}

export async function readRepositoryApproval(reader, pin, now) {
  const { issueId: id, issueNumber: number, repository, repositoryId, memberId } = pin;
  const issue = { id, number, repository, repositoryId };
  validateIssueIdentity(issue);
  requireThat(isId(memberId), 'INVALID_REPOSITORY_ADMISSION');
  const [repo, live] = await Promise.all([
    reader.repository(repository), reader.issue(issue),
  ]);
  requireThat(
    repo.id === repositoryId && repo.full_name === repository && !repo.private &&
      repo.archived === false && repo.disabled === false &&
      live.node_id === id && live.number === number && !live.pull_request &&
      live.url === `https://api.github.com${issuePath(issue)}`,
    'REPOSITORY_ISSUE_IDENTITY_CHANGED',
  );
  const assigned = live.assignees?.find((user) => user.id === memberId);
  requireThat(
    live.labels?.some((label) => label.name === 'scope') && assigned &&
      ['open', 'closed'].includes(live.state),
    'WAKE_TARGET_NOT_READY',
  );
  const prerequisites = await readPrerequisites(reader, issue);
  const record = validateApprovalRecord({
    schemaVersion: 1,
    issue,
    scope: { body: live.body, hash: digest(live.body) },
    prerequisites,
    operations: [...operations],
    roles: Object.fromEntries(
      ['author', 'validator', 'publisher', 'writer', 'acceptor']
        .map((role) => [role, memberId]),
    ),
    source: pin.source,
  }, now, { repositoryAdmission: true });
  return {
    record,
    // Publishing Shape rewrites the Issue body. Stage-specific requirements
    // checks still use current content. Keep local receipts addressable.
    scopeBinding: digest(issue),
    approvalHash: digest(pin),
    reviewers: [],
  };
}
