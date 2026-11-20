import { issuePath } from './github-read.mjs';
import { requireThat } from './identity.mjs';

export function requireActiveIssue(issue, expected) {
  requireThat(issue?.node_id === expected.id && issue.number === expected.number &&
    !issue.pull_request &&
    issue.url === `https://api.github.com${issuePath(expected)}` &&
    issue.state === 'open', 'ISSUE_CHANGED');
  requireThat(Array.isArray(issue.labels) &&
    issue.labels.every(label => typeof label?.name === 'string'), 'INVALID_LABELS');
  const labels = new Set(issue.labels.map(label => label.name));
  requireThat(labels.has('scope') && !labels.has('delivered'), 'INACTIVE_SCOPE');
  return labels;
}
