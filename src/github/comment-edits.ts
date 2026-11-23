import type { GitHubClient } from "./client.ts";
import { GitHubError, read } from "./errors.ts";
import type { Repo } from "./repo.ts";

const versionsQuery = `query($id: ID!) {
  node(id: $id) {
    ... on IssueComment {
      userContentEdits(first: 1) {
        totalCount
      }
    }
  }
}`;

interface VersionsResponse {
  data?: {
    node?: { userContentEdits?: { totalCount?: unknown } | null } | null;
  };
  errors?: unknown[];
}

/**
 * How many versions an Issue or pull request comment has had. GraphQL
 * `userContentEdits` is empty for a comment never edited; once edited it lists every
 * edit plus the original, so its `totalCount` is the number of versions.
 */
export async function readCommentVersions(
  client: GitHubClient,
  repo: Repo,
  commentId: number,
): Promise<number> {
  const operation = `read edits of comment ${repo.owner}/${repo.repo}#${commentId}`;
  const { data: comment } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      ...repo,
      comment_id: commentId,
    }),
  );
  const answer = await read(operation, () =>
    client.request("POST /graphql", {
      query: versionsQuery,
      variables: { id: comment.node_id },
    }),
  );
  const response = answer.data as VersionsResponse;
  const total = response.data?.node?.userContentEdits?.totalCount;
  if (response.errors !== undefined || typeof total !== "number") {
    const cause = new Error("GraphQL returned no edit count");
    throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
  }
  return Math.max(1, total);
}
