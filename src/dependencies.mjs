import { issuePath } from './github-read.mjs';

function identity(issue) {
  if (typeof issue?.id !== 'string' || !issue.id ||
      !Number.isSafeInteger(issue.repositoryId) || issue.repositoryId < 1) {
    throw new Error('Stable Issue and repository identities are required');
  }
  issuePath(issue);
}

async function readIssue(reader, issue) {
  identity(issue);
  const repository = await reader.repository(issue.repository);
  if (repository.id !== issue.repositoryId || repository.full_name !== issue.repository || repository.private !== false) {
    throw new Error('Public repository identity changed or is inaccessible');
  }
  const remote = await reader.issue(issue);
  if (remote.node_id !== issue.id || remote.number !== issue.number || remote.pull_request ||
      remote.url !== `https://api.github.com${issuePath(issue)}` || !['open', 'closed'].includes(remote.state)) {
    throw new Error('Issue identity changed or is inaccessible');
  }
  return remote;
}

function edgesMatch(edges, expected) {
  if (!Array.isArray(edges) || edges.length !== expected.length) return false;
  const ids = edges.map(edge => edge.node_id);
  return new Set(ids).size === ids.length && expected.every(item => {
    const edge = edges.find(value => value.node_id === item.id);
    return edge?.number === item.number && !edge.pull_request && edge.url === `https://api.github.com${issuePath(item)}`;
  });
}

// expected is the approved original dependency identity, never a stored live graph.
// This result is an observation only; execution still requires Core authorization.
export async function readDependencies(reader, issue, expected) {
  identity(issue);
  if (!Array.isArray(expected)) throw new Error('Approved prerequisite identities required');
  expected.forEach(identity);
  if (new Set(expected.map(item => item.id)).size !== expected.length || expected.some(item => item.id === issue.id)) {
    throw new Error('Duplicate or self prerequisite');
  }
  const current = await readIssue(reader, issue);
  if (current.state !== 'open') throw new Error('Target Issue is not open');
  const before = await reader.blockedBy(issue);
  if (!edgesMatch(before, expected)) throw new Error('Native Blocked by differs from approved prerequisites');
  const prerequisites = [];
  for (const item of expected) {
    const remote = await readIssue(reader, item);
    prerequisites.push({ ...item, state: remote.state });
  }
  // A graph change during cross-repository reads must not yield eligibility.
  const after = await reader.blockedBy(issue);
  if (!edgesMatch(after, expected)) throw new Error('Native Blocked by changed during observation');
  return { issue: current, prerequisites, ready: prerequisites.every(item => item.state === 'closed') };
}
