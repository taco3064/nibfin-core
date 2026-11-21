import { digest, isDigest, requireThat } from './identity.mjs';

// Compact notification context only; this never establishes publication authority.
export function issueBodyChange(event) {
  if (event?.action !== 'edited') return undefined;
  if (Object.hasOwn(event.changes?.body ?? {}, 'from') &&
    typeof event.issue?.body === 'string')
    return { before: digest(event.changes.body.from), after: digest(event.issue.body) };
  if (event.bodyChange === undefined) return undefined;
  const value = event.bodyChange;
  requireThat(value && Object.keys(value).sort().join(',') === 'after,before' &&
    isDigest(value.before) && isDigest(value.after), 'INVALID_ISSUE_BODY_CHANGE');
  return { before: value.before, after: value.after };
}

export function projectIssueBodyChange(event) {
  const bodyChange = issueBodyChange(event);
  return bodyChange ? { bodyChange } : {};
}
