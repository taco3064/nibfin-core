import type { GitHubClient } from "./client.ts";
import { GitHubError, incompleteRead, read } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { retryIncomplete } from "./retry.ts";

const versionsQuery = `query($id: ID!) {
  node(id: $id) {
    ... on IssueComment {
      userContentEdits(first: 1) {
        totalCount
      }
    }
  }
}`;

const bodyAndVersionsQuery = `query($id: ID!) {
  node(id: $id) {
    ... on IssueComment {
      body
      userContentEdits(first: 1) {
        totalCount
      }
    }
  }
}`;

interface CommentNodeResponse {
  data?: {
    node?: {
      body?: unknown;
      userContentEdits?: { totalCount?: unknown } | null;
    } | null;
  };
  errors?: unknown[];
}

function operationOf(repo: Repo, commentId: number): string {
  return `read edits of comment ${repo.owner}/${repo.repo}#${commentId}`;
}

/** One GraphQL query on the node of an Issue or pull request comment. */
async function queryComment(
  client: GitHubClient,
  repo: Repo,
  commentId: number,
  query: string,
  operation: string,
): Promise<CommentNodeResponse> {
  const { data: comment } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      ...repo,
      comment_id: commentId,
    }),
  );
  const answer = await read(operation, () =>
    client.request("POST /graphql", { query, variables: { id: comment.node_id } }),
  );
  return answer.data as CommentNodeResponse;
}

/**
 * The number of versions from `userContentEdits.totalCount`, which is empty for a
 * comment never edited and, once edited, lists every edit plus the original. GraphQL
 * `errors` fail at once (the request hook already retried them); a missing count is an
 * incomplete answer, which `retryIncomplete` retries.
 */
function versionsOf(operation: string, response: CommentNodeResponse): number {
  const total = response.data?.node?.userContentEdits?.totalCount;
  if (response.errors !== undefined) {
    const cause = new Error("GraphQL returned no edit count");
    throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
  }
  if (typeof total !== "number") {
    throw incompleteRead(operation, "GraphQL returned no edit count");
  }
  return Math.max(1, total);
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
  const operation = operationOf(repo, commentId);
  return retryIncomplete(client, operation, async () => {
    const response = await queryComment(
      client,
      repo,
      commentId,
      versionsQuery,
      operation,
    );
    return versionsOf(operation, response);
  });
}

/** A comment's body together with its number of versions, from one read. */
export interface CommentWithVersions {
  body: string;
  versions: number;
}

/**
 * The body and the number of versions of an Issue or pull request comment, both from
 * one GraphQL query on the comment node, so the counted versions include that body.
 */
export async function readCommentWithVersions(
  client: GitHubClient,
  repo: Repo,
  commentId: number,
): Promise<CommentWithVersions> {
  const operation = operationOf(repo, commentId);
  return retryIncomplete(client, operation, async () => {
    const response = await queryComment(
      client,
      repo,
      commentId,
      bodyAndVersionsQuery,
      operation,
    );
    const versions = versionsOf(operation, response);
    const body = response.data?.node?.body;
    if (typeof body !== "string") {
      throw incompleteRead(operation, "GraphQL returned no comment body");
    }
    return { body, versions };
  });
}
