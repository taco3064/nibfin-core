import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { issuePath } from './github-read.mjs';

export const operations = Object.freeze([
  'shape',
  'validate-shape',
  'publish-shape',
  'deliver',
  'hooks',
  'accept',
  'commit-pr',
  'review-pr',
  'merge',
  'close',
  'wake',
]);
const roles = ['author', 'validator', 'publisher', 'writer', 'acceptor'];
function exact(value, keys) {
  requireThat(
    value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    'INVALID_APPROVAL_RECORD',
  );
}
export function validateIssueIdentity(issue) {
  exact(issue, ['id', 'repository', 'repositoryId', 'number']);
  requireThat(
    typeof issue.id === 'string' &&
      /^I_[A-Za-z0-9_-]+$/.test(issue.id) &&
      isId(issue.repositoryId),
    'INVALID_ISSUE_IDENTITY',
  );
  issuePath(issue);
}

// This validates a bounded record, not its authority. Only a fresh native
// approval read may establish provenance; parsing this JSON grants nothing.
export function validateApprovalRecord(
  record, now, { repositoryAdmission = false } = {},
) {
  exact(record, [
    'schemaVersion',
    'issue',
    'scope',
    'prerequisites',
    'operations',
    'roles',
    'source',
    ...(repositoryAdmission ? [] : ['validFrom', 'expiresAt']),
  ]);
  requireThat(
    record.schemaVersion === 1 && Number.isSafeInteger(now),
    'INVALID_APPROVAL_RECORD',
  );
  validateIssueIdentity(record.issue);
  exact(record.scope, ['body', 'hash']);
  requireThat(
    typeof record.scope.body === 'string' &&
      record.scope.body.trim() &&
      record.scope.hash === digest(record.scope.body),
    'SCOPE_IDENTITY_MISMATCH',
  );
  requireThat(Array.isArray(record.prerequisites), 'INVALID_PREREQUISITES');
  record.prerequisites.forEach(validateIssueIdentity);
  const ids = record.prerequisites.map((issue) => issue.id);
  requireThat(
    new Set(ids).size === ids.length && !ids.includes(record.issue.id),
    'INVALID_PREREQUISITES',
  );
  requireThat(
    Array.isArray(record.operations) &&
      record.operations.length > 0 &&
      new Set(record.operations).size === record.operations.length &&
      record.operations.every((value) => operations.includes(value)),
    'INVALID_OPERATIONS',
  );
  exact(record.roles, roles);
  // GitHub member identity is distinct from isolated execution-role identity.
  // Independent Agent sessions may belong to the same authorized member; native
  // human approval remains independently checked by github-approval.mjs.
  requireThat(
    roles.every((role) => isId(record.roles[role])),
    'INVALID_ROLE_MEMBER',
  );
  exact(record.source, ['repository', 'commit', 'policyHash', 'skillsHash']);
  issuePath({ repository: record.source.repository, number: 1 });
  requireThat(
    isSha(record.source.commit) &&
      isDigest(record.source.policyHash) &&
      isDigest(record.source.skillsHash),
    'INVALID_SOURCE_IDENTITY',
  );
  if (repositoryAdmission) return record;
  const start = Date.parse(record.validFrom),
    end = Date.parse(record.expiresAt);
  requireThat(
    typeof record.validFrom === 'string' &&
      typeof record.expiresAt === 'string' &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start < end &&
      start <= now &&
      now < end,
    'EXPIRED_OR_INACTIVE_APPROVAL',
  );
  return record;
}

export function bindRawScope(record, remote) {
  const issue = record.issue;
  requireThat(
    remote?.node_id === issue.id &&
      remote.number === issue.number &&
      !remote.pull_request &&
      remote.url === `https://api.github.com${issuePath(issue)}` &&
      remote.state === 'open',
    'ISSUE_IDENTITY_MISMATCH',
  );
  requireThat(
    typeof remote.body === 'string' && remote.body.trim(),
    'EMPTY_ISSUE_BODY',
  );
  // Labels never replace content/provenance verification.
  return { issueId: issue.id, scopeHash: digest(remote.body) };
}
