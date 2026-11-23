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

/** One GraphQL query on the node of an Issue or pull request comment. */
async function queryComment(
  client: GitHubClient,
  repo: Repo,
  commentId: number,
  query: string,
): Promise<{ operation: string; response: CommentNodeResponse }> {
  const operation = `read edits of comment ${repo.owner}/${repo.repo}#${commentId}`;
  const { data: comment } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      ...repo,
      comment_id: commentId,
    }),
  );
  const answer = await read(operation, () =>
    client.request("POST /graphql", { query, variables: { id: comment.node_id } }),
  );
  return { operation, response: answer.data as CommentNodeResponse };
}

/**
 * The number of versions from `userContentEdits.totalCount`, which is empty for a
 * comment never edited and, once edited, lists every edit plus the original.
 */
function versionsOf(operation: string, response: CommentNodeResponse): number {
  const total = response.data?.node?.userContentEdits?.totalCount;
  if (response.errors !== undefined || typeof total !== "number") {
    const cause = new Error("GraphQL returned no edit count");
    throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
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
  const { operation, response } = await queryComment(
    client,
    repo,
    commentId,
    versionsQuery,
  );
  return versionsOf(operation, response);
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
  const { operation, response } = await queryComment(
    client,
    repo,
    commentId,
    bodyAndVersionsQuery,
  );
  const versions = versionsOf(operation, response);
  const body = response.data?.node?.body;
  if (typeof body !== "string") {
    const cause = new Error("GraphQL returned no comment body");
    throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
  }
  return { body, versions };
}
