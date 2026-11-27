import type { ActingClient } from "./client.ts";
import { readBlocking } from "./dependencies.ts";
import { GitHubError, read } from "./errors.ts";
import { readIssueRecord } from "./issue-query.ts";
import { formatIssue, type IssueRef, type Repo } from "./repo.ts";
import { write } from "./write.ts";

/**
 * The writes the Scope stage publishes a request's plan with (#736): Issues, native
 * Blocked by edges and Assignees. Each goes through `write()` with a `confirm` that
 * re-reads GitHub before any re-send (Proposal R4.37, R4.38) and is read back.
 */

/** An Issue as a write needs it: its address, URL and REST `id`. */
export interface IssueHandle {
  ref: IssueRef;
  url: string;
  /** The REST `id` (not the number), which `issue_id` of a dependency names. */
  id: number;
}

interface RestIssue {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  pull_request?: unknown;
}

function handleOf(repo: Repo, issue: RestIssue): IssueHandle {
  return {
    ref: { owner: repo.owner, repo: repo.repo, number: issue.number },
    url: issue.html_url,
    id: issue.id,
  };
}

function unconfirmed(operation: string, reason: string): GitHubError {
  return new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error(reason));
}

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * `GET /repos/{owner}/{repo}/issues/{issue_number}`: the Issue's handle with GitHub's
 * own URL. A pull request is `GITHUB_READ_FAILED`.
 */
export async function readIssueId(
  client: ActingClient,
  issue: IssueRef,
): Promise<IssueHandle> {
  const operation = `read the id of ${formatIssue(issue)}`;
  const { data } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
    }),
  );
  const found = data as RestIssue;
  if (found.pull_request !== undefined) {
    const cause = new Error(`${formatIssue(issue)} is a pull request`);
    throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
  }
  return handleOf(issue, found);
}

/**
 * The newest Issue (not a pull request) the actor created in `repo` with exactly
 * `title` and `body`, from the first page (100) of the repository's Issue listing,
 * newest first; never search. `undefined` when there is none.
 */
export async function findCreatedIssue(
  client: ActingClient,
  repo: Repo,
  title: string,
  body: string,
): Promise<IssueHandle | undefined> {
  const { data } = await read(`list Issues of ${repo.owner}/${repo.repo}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues", {
      owner: repo.owner,
      repo: repo.repo,
      state: "all",
      creator: client.actor.login,
      sort: "created",
      direction: "desc",
      per_page: 100,
    }),
  );
  const found = (data as RestIssue[]).find(
    (issue) =>
      issue.pull_request === undefined &&
      issue.title === title &&
      (issue.body ?? "") === body,
  );
  return found === undefined ? undefined : handleOf(repo, found);
}

/**
 * Creates an Issue with `title` and `body` only: no labels or Assignees, so it is not
 * eligible for Shape yet. An unknown outcome is checked with `findCreatedIssue`.
 */
export async function createIssue(
  client: ActingClient,
  repo: Repo,
  text: { title: string; body: string },
): Promise<IssueHandle> {
  return write(
    client,
    `create Issue "${text.title}" in ${repo.owner}/${repo.repo}`,
    async () => {
      const { data } = await client.request("POST /repos/{owner}/{repo}/issues", {
        owner: repo.owner,
        repo: repo.repo,
        title: text.title,
        body: text.body,
      });
      return handleOf(repo, data as RestIssue);
    },
    { confirm: () => findCreatedIssue(client, repo, text.title, text.body) },
  );
}

/**
 * Makes `blocked` natively Blocked by `blocker`
 * (`POST …/issues/{n}/dependencies/blocked_by` with the blocker's `issue_id`). An edge
 * already in place is not written again; a 4xx (such as an edge that already exists)
 * is recovered by reading the edge back. Both directions must read back: `blocked`'s
 * Blocked by has `blocker`, and `blocker`'s blocking has `blocked`; otherwise
 * `GITHUB_WRITE_UNCONFIRMED`. Returns whether it wrote.
 */
export async function addBlockedBy(
  client: ActingClient,
  blocked: Omit<IssueHandle, "id">,
  blocker: IssueHandle,
): Promise<boolean> {
  const operation = `add ${blocker.url} as Blocked by of ${blocked.url}`;
  const present = async () =>
    (await readIssueRecord(client, blocked.ref)).blockedBy.some((issue) =>
      sameText(issue.url, blocker.url),
    );
  const confirm = async () => ((await present()) ? true : undefined);
  let wrote = false;
  if (!(await present())) {
    await write(
      client,
      operation,
      async () => {
        await client.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
          {
            owner: blocked.ref.owner,
            repo: blocked.ref.repo,
            issue_number: blocked.ref.number,
            issue_id: blocker.id,
          },
        );
        return true;
      },
      { confirm, recover: () => confirm() },
    );
    wrote = true;
  }
  if (!(await present())) {
    throw unconfirmed(operation, "The Blocked by list lacks the blocker");
  }
  const blocking = await readBlocking(client, blocker.ref);
  if (!blocking.some((issue) => sameText(issue.url, blocked.url))) {
    throw unconfirmed(operation, "The blocker's blocking list lacks the Issue");
  }
  return wrote;
}

/**
 * Adds every login in `logins` that is not yet an Assignee of `issue`
 * (`POST …/assignees`); existing Assignees stay. GitHub silently ignores an Assignee
 * it cannot add, so each login must read back, else `GITHUB_WRITE_UNCONFIRMED`.
 * Returns whether it wrote.
 */
export async function addAssignees(
  client: ActingClient,
  issue: IssueRef,
  logins: readonly string[],
): Promise<boolean> {
  const operation = `add Assignees to ${formatIssue(issue)}`;
  const missing = async () => {
    const { assignees } = await readIssueRecord(client, issue);
    return logins.filter(
      (login) => !assignees.some((assignee) => sameText(assignee.login, login)),
    );
  };
  const absent = await missing();
  if (absent.length === 0) {
    return false;
  }
  await write(
    client,
    operation,
    async () => {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        assignees: absent,
      });
      return true;
    },
    { confirm: async () => ((await missing()).length === 0 ? true : undefined) },
  );
  const left = await missing();
  if (left.length > 0) {
    throw unconfirmed(operation, `GitHub did not assign ${left.join(", ")}`);
  }
  return true;
}
