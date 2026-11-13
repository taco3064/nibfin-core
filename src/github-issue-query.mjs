import { ghQuery, repositoryMetadata } from './github-host-read.mjs';
import { issuePath } from './github-read.mjs';
import { isId, requireThat } from './identity.mjs';

const query = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId nameWithOwner isPrivate isArchived isDisabled defaultBranchRef { name }
    issue(number: $number) {
      id number body state
      assignees(first: 100) { nodes { databaseId login } pageInfo { hasNextPage } }
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      blockedBy(first: 100) {
        nodes { id number repository { databaseId nameWithOwner isPrivate } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

function complete(connection) {
  requireThat(Array.isArray(connection?.nodes) &&
    connection.pageInfo?.hasNextPage === false, 'INCOMPLETE_ISSUE_QUERY');
  return connection.nodes;
}

export async function readIssueQuery(issue, token, request = ghQuery) {
  const repo = await request(issue.repository, token, query, { number: issue.number });
  const item = repo.issue;
  requireThat(item && typeof item.body === 'string' &&
    ['OPEN', 'CLOSED'].includes(item.state), 'INVALID_ISSUE_QUERY');
  const prerequisites = complete(item.blockedBy).map(edge => {
    requireThat(isId(edge.repository?.databaseId) &&
      edge.repository.isPrivate === false &&
      isId(edge.number) && typeof edge.id === 'string', 'INVALID_NATIVE_PREREQUISITE');
    const repository = edge.repository.nameWithOwner;
    issuePath({ repository, number: edge.number });
    return { id: edge.id, number: edge.number, repository,
      repositoryId: edge.repository.databaseId };
  });
  return {
    repository: repositoryMetadata(repo),
    issue: { node_id: item.id, number: item.number, body: item.body,
      state: item.state.toLowerCase(), url: `https://api.github.com${issuePath(issue)}`,
      labels: complete(item.labels),
      assignees: complete(item.assignees).map(user => ({
        id: user.databaseId, login: user.login, type: 'User',
      })) },
    prerequisites,
  };
}
