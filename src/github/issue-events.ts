import type { ActingClient } from "./client.ts";
import { read } from "./errors.ts";
import { formatIssue, type IssueRef, type Repo } from "./repo.ts";

/** An Issue comment as REST reads it by id, with when its body last changed. */
export interface IssueComment {
  id: number;
  body: string;
  url: string;
  /** REST `updated_at` (ISO 8601). */
  updatedAt: string;
}

/** The Issue comment `id` of `repo`, by `GET …/issues/comments/{comment_id}`. */
export async function readIssueComment(
  client: ActingClient,
  repo: Repo,
  id: number,
): Promise<IssueComment> {
  const { data } = await read(`read comment ${id} of ${repo.owner}/${repo.repo}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: repo.owner,
      repo: repo.repo,
      comment_id: id,
    }),
  );
  return { id, body: data.body ?? "", url: data.html_url, updatedAt: data.updated_at };
}

/**
 * When `label` was last removed from `issue`: the latest `created_at` of an
 * `unlabeled` event for it among all the Issue's events
 * (`GET /repos/{owner}/{repo}/issues/{issue_number}/events`, every page), or `null`
 * when it never was.
 */
export async function readLastUnlabeled(
  client: ActingClient,
  issue: IssueRef,
  label: string,
): Promise<string | null> {
  const events = await read(`list events of ${formatIssue(issue)}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/events", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
      per_page: 100,
    }),
  );
  let latest: string | null = null;
  for (const event of events) {
    const name = (event as { label?: { name?: unknown } | null }).label?.name;
    if (event.event !== "unlabeled" || name !== label) {
      continue;
    }
    if (latest === null || Date.parse(event.created_at) > Date.parse(latest)) {
      latest = event.created_at;
    }
  }
  return latest;
}

/** An Issue comment as the REST comment list gives it, with its author's login. */
export interface ListedComment {
  id: number;
  /** `null` for a deleted account. */
  login: string | null;
  body: string;
  /** REST `created_at` (ISO 8601). */
  createdAt: string;
  url: string;
}

/**
 * Every comment of `issue`, oldest first
 * (`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, every page).
 */
export async function listIssueComments(
  client: ActingClient,
  issue: IssueRef,
): Promise<ListedComment[]> {
  const comments = await read(`list comments of ${formatIssue(issue)}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
      per_page: 100,
    }),
  );
  return comments.map((comment) => ({
    id: comment.id,
    login: comment.user?.login ?? null,
    body: comment.body ?? "",
    createdAt: comment.created_at,
    url: comment.html_url,
  }));
}
