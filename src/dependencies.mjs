import { issuePath } from './github-read.mjs';
import { isDeepStrictEqual } from 'node:util';

// Native lifecycle state is an eligibility condition, not an execution grant.
// Manual bootstrap gates are not normal protected-delivery prerequisites.
export function isDeliveredIssue(issue) {
  return issue?.state === 'closed' && Array.isArray(issue.labels) &&
    ['scope', 'shaped', 'delivered'].every(name =>
      issue.labels.some(label => label?.name === name));
}

function identity(issue) {
  if (typeof issue?.id !== 'string' || !issue.id ||
      !Number.isSafeInteger(issue.repositoryId) || issue.repositoryId < 1) {
    throw new Error('Stable Issue and repository identities are required');
  }
  issuePath(issue);
}

async function readIssue(reader, issue, observed = {}) {
  identity(issue);
  const repository = observed.repository ?? await reader.repository(issue.repository);
  if (repository.id !== issue.repositoryId ||
      repository.full_name !== issue.repository || repository.private !== false) {
    throw new Error('Public repository identity changed or is inaccessible');
  }
  const remote = observed.issue ?? await reader.issue(issue);
  if (remote.node_id !== issue.id || remote.number !== issue.number ||
      remote.pull_request || remote.url !== `https://api.github.com${issuePath(issue)}` ||
      !['open', 'closed'].includes(remote.state)) {
    throw new Error('Issue identity changed or is inaccessible');
  }
  return remote;
}

function edgesMatch(edges, expected) {
  if (!Array.isArray(edges) || edges.length !== expected.length) return false;
  const ids = edges.map(edge => edge.node_id);
  return new Set(ids).size === ids.length && expected.every(item => {
    const edge = edges.find(value => value.node_id === item.id);
    return edge?.number === item.number && !edge.pull_request &&
      edge.url === `https://api.github.com${issuePath(item)}`;
  });
}

// expected is the approved original dependency identity, never a stored live graph.
// This result is an observation only; execution still requires Core authorization.
export async function readDependencies(reader, issue, expected, observed) {
  identity(issue);
  if (!Array.isArray(expected))
    throw new Error('Approved prerequisite identities required');
  expected.forEach(identity);
  if (new Set(expected.map(item => item.id)).size !== expected.length ||
      expected.some(item => item.id === issue.id)) {
    throw new Error('Duplicate or self prerequisite');
  }
  const current = await readIssue(reader, issue, observed);
  if (current.state !== 'open') throw new Error('Target Issue is not open');
  if (observed?.dependencies && observed.dependencies.length !== expected.length)
    throw new Error('Grouped dependency count changed during observation');
  if (!observed?.dependencies) {
    const before = await reader.blockedBy(issue);
    if (!edgesMatch(before, expected))
      throw new Error('Native Blocked by differs from approved prerequisites');
  }
  const prerequisites = [];
  for (const [index, item] of expected.entries()) {
    const grouped = observed?.dependencies?.[index];
    if (observed?.dependencies && !isDeepStrictEqual(grouped?.identity, item))
      throw new Error('Grouped dependency identity changed during observation');
    const repository = item.repository === issue.repository
      ? observed?.repository : undefined;
    const remote = grouped ?? await readIssue(reader, item, { repository });
    prerequisites.push({ ...item, state: remote.state,
      completed: isDeliveredIssue(remote) });
  }
  // A grouped read supplies edges and prerequisite state in the same response.
  // The separate REST reads still need to guard against changes in between.
  if (!observed?.dependencies) {
    const after = await reader.blockedBy(issue);
    if (!edgesMatch(after, expected))
      throw new Error('Native Blocked by changed during observation');
  }
  return { issue: current, prerequisites,
    ready: prerequisites.every(item => item.completed) };
}
