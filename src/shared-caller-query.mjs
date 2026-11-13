import { ghData, repositoryMetadata } from './github-host-read.mjs';
import { isSha, requireThat } from './identity.mjs';

const query = `query($owner: String!, $name: String!, $anchor: String!, $path: String!,
  $workflow: ID!) {
  node(id: $workflow) {
    ... on Workflow { databaseId resourcePath state }
  }
  repository(owner: $owner, name: $name) {
    databaseId nameWithOwner isPrivate isArchived isDisabled
    defaultBranchRef {
      name
      compare(headRef: $anchor) { status baseTarget { oid } headTarget { oid } }
      target { ...CallerCommit }
    }
    object(expression: $anchor) { ...CallerCommit }
  }
}
fragment CallerCommit on Commit {
  oid
  file(path: $path) { oid mode object { ... on Blob { byteSize } } }
  history(first: 1, path: $path) { nodes { oid } }
}`;

// Initial host admission verifies the actual run revision. Subsequent observations
// check current workflow state and continuity together against the same anchor.
export async function readSharedCaller(
  expected, workflowNodeId, token, request = ghData,
) {
  const { repository, sourceAnchor, workflowPath } = expected;
  const observed = await request(repository, token, query, {
    anchor: sourceAnchor, path: workflowPath, workflow: workflowNodeId,
  }).catch(() => undefined);
  if (!observed) return undefined;

  const repo = observed.repository, branch = repo?.defaultBranchRef;
  const anchor = repo.object, latest = branch?.target, compare = branch?.compare;
  requireThat(isSha(latest?.oid) && anchor?.oid === sourceAnchor &&
    compare?.baseTarget?.oid === latest.oid && compare.headTarget?.oid === sourceAnchor &&
    compare.status === (latest.oid === sourceAnchor ? 'IDENTICAL' : 'BEHIND'),
  'CALLER_SOURCE_NOT_DESCENDANT');
  for (const { file } of [anchor, latest]) {
    requireThat(file?.oid === expected.workflowBlob &&
      [0o100644, 0o100755].includes(file.mode) &&
      Number.isSafeInteger(file.object?.byteSize) && file.object.byteSize > 0 &&
      file.object.byteSize <= 1024 * 1024, 'PINNED_FILE_UNAVAILABLE');
  }
  const lastChange = anchor.history?.nodes?.[0]?.oid;
  requireThat(isSha(lastChange) && latest.history?.nodes?.[0]?.oid === lastChange,
    'CALLER_REVOKED_OR_SUPERSEDED');
  const workflow = observed.node;
  const filename = workflowPath.split('/').at(-1);
  requireThat(workflow?.databaseId === expected.workflowId &&
    workflow.resourcePath === `/${repository}/actions/workflows/${filename}` &&
    workflow.state === 'ACTIVE', 'WORKFLOW_DISABLED_OR_CHANGED');
  return { repository: repositoryMetadata(repo),
    workflow: { id: workflow.databaseId, path: workflowPath, state: 'active' } };
}
