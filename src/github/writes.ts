import {
  branchExists,
  type PullRequestSummary,
  readPullRequests,
  summarizePullRequest,
} from "./branches.ts";
import type { ActingClient } from "./client.ts";
import { GitHubError, read, responseMessage, statusOf } from "./errors.ts";
import { nibfinLabels } from "./labels.ts";
import type { MergeMethod } from "./merge-methods.ts";
import { readPullRequest } from "./pull-request.ts";
import { type RecordComment, readIssueRecord } from "./issue-query.ts";
import { formatIssue, type IssueRef, type Repo } from "./repo.ts";
import { write, writeOnce } from "./write.ts";

export interface PullRequestRequest {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** The open pull request of `branch`, created when there is none. */
export async function ensurePullRequest(
  client: ActingClient,
  repo: Repo,
  request: PullRequestRequest,
): Promise<PullRequestSummary> {
  const findOpen = async () =>
    (await readPullRequests(client, repo, request.branch, "open")).at(0);
  const existing = await findOpen();
  if (existing) {
    return existing;
  }
  return write(
    client,
    `create pull request ${repo.owner}/${repo.repo}:${request.branch}`,
    async () => {
      const { data } = await client.request("POST /repos/{owner}/{repo}/pulls", {
        ...repo,
        head: request.branch,
        base: request.base,
        title: request.title,
        body: request.body,
      });
      return summarizePullRequest(data);
    },
    {
      confirm: findOpen,
      recover: async (error) => (isAlreadyExists(error) ? findOpen() : undefined),
    },
  );
}

/** A 422 whose validation errors say the pull request already exists. */
function isAlreadyExists(error: unknown): boolean {
  if (statusOf(error) !== 422) {
    return false;
  }
  const { response } = error as { response: { data?: unknown } };
  const data = response.data as { errors?: Array<{ message?: unknown }> } | undefined;
  return (data?.errors ?? []).some(
    (item) => typeof item.message === "string" && /already exists/i.test(item.message),
  );
}

export interface MarkedComment {
  id: number;
  body: string;
  url: string;
}

/** The marker that starts a Nibfin comment: `<!-- nibfin:<key> -->`. */
export function commentMarker(key: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    throw new TypeError(`Invalid comment key: ${key}`);
  }
  return `<!-- nibfin:${key} -->`;
}

/** What a marked comment is on: an Issue (the default) or a pull request. */
export type CommentTarget = "issue" | "pull-request";

/** The oldest of `comments` by the actor that starts with the marker of `key`. */
function oldestMarked<T extends { id: number; body: string }>(
  comments: ReadonlyArray<T & { authorId: number | null }>,
  actor: number,
  marker: string,
): T | undefined {
  return comments
    .filter((comment) => comment.authorId === actor && comment.body.startsWith(marker))
    .toSorted((a, b) => a.id - b.id)
    .at(0);
}

/**
 * The actor's oldest marked comment of `key` on Issue `issue` as the Issue record reads
 * it, with its number of versions.
 */
export async function readMarkedComment(
  client: ActingClient,
  issue: IssueRef,
  key: string,
): Promise<RecordComment | undefined> {
  const marker = commentMarker(key);
  const { comments } = await readIssueRecord(client, issue);
  return oldestMarked(comments, client.actor.id, marker);
}

/**
 * The oldest comment on `target` that starts with the marker of `key` and was written by
 * the client's actor. Comments of other authors never count. An Issue's comments come
 * from its Issue record; a pull request's from the REST comment list.
 */
export async function findMarkedComment(
  client: ActingClient,
  target: IssueRef,
  key: string,
  on: CommentTarget = "issue",
): Promise<MarkedComment | undefined> {
  const marker = commentMarker(key);
  if (on === "issue") {
    const found = await readMarkedComment(client, target, key);
    return found === undefined
      ? undefined
      : { id: found.id, body: found.body, url: found.url };
  }
  const comments = await read(`list comments of ${formatIssue(target)}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      per_page: 100,
    }),
  );
  return oldestMarked(
    comments.map(({ id, user, body, html_url }) => ({
      id,
      authorId: user?.id ?? null,
      body: body ?? "",
      url: html_url,
    })),
    client.actor.id,
    marker,
  );
}

/**
 * Writes `<marker>\n<body>` as the actor's marked comment of `key`: updates the oldest
 * one in place (others are left alone), creates it when there is none, and skips the
 * write when the body is unchanged. Returns the comment as re-read.
 */
export async function upsertMarkedComment(
  client: ActingClient,
  target: IssueRef,
  key: string,
  body: string,
  on: CommentTarget = "issue",
): Promise<MarkedComment> {
  const desired = `${commentMarker(key)}\n${body}`;
  const find = () => findMarkedComment(client, target, key, on);
  const existing = await find();
  if (existing?.body === desired) {
    return existing;
  }
  const confirm = async () => {
    const comment = await find();
    return comment?.body === desired ? comment : undefined;
  };
  const operation = `write ${key} comment on ${formatIssue(target)}`;
  await write(
    client,
    operation,
    async () => {
      if (existing) {
        await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner: target.owner,
          repo: target.repo,
          comment_id: existing.id,
          body: desired,
        });
      } else {
        await client.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: target.owner,
            repo: target.repo,
            issue_number: target.number,
            body: desired,
          },
        );
      }
      return true;
    },
    { confirm: async () => ((await confirm()) ? true : undefined) },
  );
  const comment = await find();
  if (!comment) {
    throw new GitHubError(
      "GITHUB_WRITE_UNCONFIRMED",
      operation,
      new Error("The comment was not found after the write"),
    );
  }
  return comment;
}

export interface LabelChanges {
  add?: readonly string[];
  remove?: readonly string[];
}

async function readLabels(client: ActingClient, issue: IssueRef): Promise<string[]> {
  return (await readIssueRecord(client, issue)).labels;
}

/**
 * Adds and removes labels so the Issue ends with every `add` and no `remove`; labels
 * already in place are not written again. Returns the labels as re-read.
 */
export async function setLabels(
  client: ActingClient,
  issue: IssueRef,
  changes: LabelChanges,
): Promise<string[]> {
  const add = changes.add ?? [];
  const remove = changes.remove ?? [];
  if (add.some((label) => remove.includes(label))) {
    throw new TypeError("A label cannot be both added and removed");
  }
  const current = await readLabels(client, issue);
  const toAdd = add.filter((label) => !current.includes(label));
  const toRemove = remove.filter((label) => current.includes(label));
  const where = formatIssue(issue);
  if (toAdd.length > 0) {
    await write(
      client,
      `add labels to ${where}`,
      async () => {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner: issue.owner,
          repo: issue.repo,
          issue_number: issue.number,
          labels: toAdd,
        });
        return true;
      },
      {
        confirm: async () => {
          const labels = await readLabels(client, issue);
          return toAdd.every((label) => labels.includes(label)) ? true : undefined;
        },
      },
    );
  }
  for (const label of toRemove) {
    const absent = async () =>
      (await readLabels(client, issue)).includes(label) ? undefined : true;
    await write(
      client,
      `remove label ${label} from ${where}`,
      async () => {
        await client.request(
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
          {
            owner: issue.owner,
            repo: issue.repo,
            issue_number: issue.number,
            name: label,
          },
        );
        return true;
      },
      {
        confirm: absent,
        recover: async (error) => (statusOf(error) === 404 ? absent() : undefined),
      },
    );
  }
  return readLabels(client, issue);
}

async function readIssueState(client: ActingClient, issue: IssueRef): Promise<string> {
  return (await readIssueRecord(client, issue)).state;
}

/**
 * Adds `delivered`, then closes the Issue as completed. An open Issue that already has
 * `delivered` still derives `done`, so a repeated call finishes the close.
 */
export async function closeDelivered(
  client: ActingClient,
  issue: IssueRef,
): Promise<void> {
  await setLabels(client, issue, { add: [nibfinLabels.delivered] });
  if ((await readIssueState(client, issue)) === "closed") {
    return;
  }
  await write(
    client,
    `close ${formatIssue(issue)}`,
    async () => {
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: "completed",
      });
      return true;
    },
    {
      confirm: async () =>
        (await readIssueState(client, issue)) === "closed" ? true : undefined,
    },
  );
}

/**
 * Deletes branch `name` of `repo` (`DELETE …/git/refs/heads/<name>`, #700). GitHub
 * documents no answer for a missing ref, so after an unknown outcome or any 4xx the ref
 * is read again: absent (404) means done; otherwise the failure stands.
 */
export async function deleteBranch(
  client: ActingClient,
  repo: Repo,
  name: string,
): Promise<void> {
  const absent = async () =>
    (await branchExists(client, repo, name)) ? undefined : true;
  await write(
    client,
    `delete branch ${repo.owner}/${repo.repo}:${name}`,
    async () => {
      await client.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        ...repo,
        ref: `heads/${name}`,
      });
      return true;
    },
    { confirm: absent, recover: () => absent().catch(() => undefined) },
  );
}

export interface MergeRequest {
  number: number;
  /** The head the pull request must still have; GitHub answers 409 otherwise. */
  sha: string;
  method: MergeMethod;
}

/** What a merge did; `not-mergeable` keeps GitHub's message. */
export type MergeResult =
  | { outcome: "merged"; mergeCommitSha: string | null }
  | { outcome: "head-changed" }
  | { outcome: "not-mergeable"; message: string };

/**
 * Merges pull request `number` only at head `sha` with `method`, in one attempt: its
 * retries re-check the Issue's stage first, so they live in the review stage
 * (`mergeReviewed`). 409 is
 * `head-changed`, 405 `not-mergeable` with GitHub's message; any other 4xx (403, 422,
 * …) is `GITHUB_WRITE_REJECTED`. An unknown outcome re-reads the pull request: merged
 * at `sha` is the merge, otherwise `GITHUB_WRITE_UNCONFIRMED`.
 */
export async function mergePullRequest(
  client: ActingClient,
  repo: Repo,
  request: MergeRequest,
): Promise<MergeResult> {
  const where = `${repo.owner}/${repo.repo}#${request.number}`;
  return writeOnce<MergeResult>(
    `merge pull request ${where} at ${request.sha}`,
    async () => {
      const { data } = await client.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          ...repo,
          pull_number: request.number,
          sha: request.sha,
          merge_method: request.method,
        },
      );
      return { outcome: "merged", mergeCommitSha: data.sha };
    },
    {
      confirm: async () => {
        const pull = await readPullRequest(client, repo, request.number);
        return pull.merged && pull.headSha === request.sha
          ? { outcome: "merged", mergeCommitSha: pull.mergeCommitSha }
          : undefined;
      },
      recover: (error) => {
        const status = statusOf(error);
        if (status === 409) {
          return Promise.resolve({ outcome: "head-changed" });
        }
        if (status === 405) {
          const message = responseMessage(error) ?? "The merge cannot be performed";
          return Promise.resolve({ outcome: "not-mergeable", message });
        }
        return Promise.resolve(undefined);
      },
    },
  );
}
