import { projectIssueBodyChange } from './issue-body-change.mjs';
import { isId, requireThat } from './identity.mjs';

// A notification locator, never proof of current eligibility or delivery.
export const managedWakeContract = Object.freeze({
  schemaVersion: 1,
  artifactPrefix: 'nibfin-issue-wake-v1',
  fileName: 'issue-wake.json',
  maxBytes: 4096,
});
export function managedWakeArtifactName(attempt) {
  requireThat(isId(attempt), 'INVALID_MANAGED_WAKE_IDENTITY');
  return `${managedWakeContract.artifactPrefix}-${attempt}`;
}

export const issueWakeActions = Object.freeze([
  'opened', 'edited', 'labeled', 'unlabeled', 'assigned', 'unassigned',
  'reopened', 'closed',
]);

export function supportsIssueWakeEvent(event) {
  return issueWakeActions.includes(event?.action) &&
    (event.action !== 'labeled' || ['scope', 'pause'].includes(event.label?.name));
}

export function issueWakeMode(value = '') {
  requireThat(['', 'legacy', 'managed'].includes(value), 'INVALID_ISSUE_WAKE_MODE');
  return value || 'legacy';
}

function text(value, pattern) {
  requireThat(typeof value === 'string' && pattern.test(value),
    'INVALID_MANAGED_WAKE_IDENTITY');
  return value;
}

function actor(value) {
  requireThat(isId(value?.id) && ['User', 'Bot', 'Organization'].includes(value.type),
    'INVALID_MANAGED_WAKE_ACTOR');
  return { id: value.id, login: text(value.login, /^[A-Za-z0-9_-]{1,100}(\[bot\])?$/),
    type: value.type };
}

export function projectManagedWake(event, origin) {
  requireThat(origin?.eventName === 'issues' &&
    supportsIssueWakeEvent(event) && !event.issue?.pull_request,
  'UNSUPPORTED_ISSUE_EVENT');
  const repository = event.repository, issue = event.issue;
  requireThat(isId(repository?.id) && isId(issue?.number) && isId(issue.id) &&
    isId(origin.runId) && isId(origin.attempt) &&
    repository.full_name === origin.repository &&
    ['open', 'closed'].includes(issue.state), 'INVALID_MANAGED_WAKE_IDENTITY');
  const fullName = text(repository.full_name,
    /^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
  requireThat(Array.isArray(issue.labels) && Array.isArray(issue.assignees),
    'INVALID_MANAGED_WAKE_CONTEXT');
  const projected = {
    schemaVersion: managedWakeContract.schemaVersion,
    runId: origin.runId,
    attempt: origin.attempt,
    event: {
      action: event.action,
      ...projectIssueBodyChange(event),
      repository: { id: repository.id, full_name: fullName },
      issue: {
        id: issue.id, number: issue.number,
        node_id: text(issue.node_id, /^I_[A-Za-z0-9_-]{1,200}$/),
        state: issue.state,
        updated_at: text(issue.updated_at,
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        assignees: issue.assignees.map(actor),
        labels: issue.labels.filter(item => ['pause', 'delivered'].includes(item?.name))
          .map(({ name }) => ({ name })),
      },
      ...(event.sender ? { sender: actor(event.sender) } : {}),
    },
  };
  if (['labeled', 'unlabeled'].includes(event.action)) {
    projected.event.label = { name: text(event.label?.name, /^[^\x00-\x1f]{1,50}$/) };
    if (event.label.name === 'pause')
      requireThat(projected.event.sender, 'INVALID_MANAGED_WAKE_ACTOR');
  }
  serializeManagedWake(projected);
  return projected;
}

export function serializeManagedWake(projected) {
  const bytes = JSON.stringify(projected) + '\n';
  requireThat(Buffer.byteLength(bytes, 'utf8') <= managedWakeContract.maxBytes,
    'MANAGED_WAKE_TOO_LARGE');
  return bytes;
}
