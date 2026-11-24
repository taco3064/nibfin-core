import type { GitHubClient } from "./client.ts";
import { read, readOptional } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** The branch that delivers Issue `n`. */
export function deliveryBranch(issueNumber: number): string {
  return `nibfin/issue-${issueNumber}`;
}

/** The branch of the `k`-th fix after a CD failure of Issue `n`. */
export function cdFixBranch(issueNumber: number, k: number): string {
  return `${deliveryBranch(issueNumber)}-cd-${k}`;
}

const issueBranchPattern = /^nibfin\/issue-([1-9]\d*)(?:-cd-[1-9]\d*)?$/;

/**
 * The Issue number of a delivery branch `nibfin/issue-<n>` or a CD fix branch
 * `nibfin/issue-<n>-cd-<k>`; `undefined` for any other branch.
 */
export function issueOfBranch(branch: string): number | undefined {
  const match = issueBranchPattern.exec(branch);
  return match === null ? undefined : Number(match[1]);
}

export interface PullRequestSummary {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeCommitSha: string | null;
  url: string;
}

export interface BranchProbe {
  name: string;
  /** True when the branch ref exists; merged branches may have been deleted. */
  exists: boolean;
  /** Pull requests whose head is this branch, newest first. */
  pullRequests: PullRequestSummary[];
}

export interface IssueBranches {
  delivery: BranchProbe;
  /** Fix branches `-cd-1`, `-cd-2`, … that have a pull request or a ref. */
  fixes: BranchProbe[];
  /** The highest existing fix branch, else the delivery branch. */
  current: BranchProbe;
  /** The branch a new CD-failure fix would use. */
  nextFixBranch: string;
}

/** Pull requests (any state) whose head is `branch` in `repo`, newest first. */
export async function readPullRequests(
  client: GitHubClient,
  repo: Repo,
  branch: string,
  state: "open" | "all" = "all",
): Promise<PullRequestSummary[]> {
  const pulls = await read(
    `list pull requests of ${repo.owner}/${repo.repo}:${branch}`,
    () =>
      client.paginate("GET /repos/{owner}/{repo}/pulls", {
        ...repo,
        head: `${repo.owner}:${branch}`,
        state,
        per_page: 100,
      }),
  );
  return pulls
    .filter((pull) => pull.head.ref === branch)
    .map(summarizePullRequest)
    .toSorted((a, b) => b.number - a.number);
}

/** The fields of a pull request (list or single) that Nibfin uses. */
export interface PullRequestData {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  merge_commit_sha: string | null;
  html_url: string;
}

export function summarizePullRequest(pull: PullRequestData): PullRequestSummary {
  return {
    number: pull.number,
    state: pull.state === "open" ? "open" : "closed",
    merged: pull.merged_at !== null,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    mergeCommitSha: pull.merge_commit_sha,
    url: pull.html_url,
  };
}

/** Whether the ref of branch `name` exists in `repo` (404 = absent). */
export async function branchExists(
  client: GitHubClient,
  repo: Repo,
  name: string,
): Promise<boolean> {
  const ref = await readOptional(`read ref of ${repo.owner}/${repo.repo}:${name}`, () =>
    client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repo,
      ref: `heads/${name}`,
    }),
  );
  return ref !== undefined;
}

/** Probes one branch: its pull requests and whether its ref exists (404 = absent). */
export async function probeBranch(
  client: GitHubClient,
  repo: Repo,
  name: string,
): Promise<BranchProbe> {
  const pullRequests = await readPullRequests(client, repo, name);
  const exists = await branchExists(client, repo, name);
  return { name, exists, pullRequests };
}

/**
 * The delivery branch and every fix branch `-cd-1`, `-cd-2`, … up to the first `k` that
 * has neither a pull request nor a ref.
 */
export async function readIssueBranches(
  client: GitHubClient,
  repo: Repo,
  issueNumber: number,
): Promise<IssueBranches> {
  const delivery = await probeBranch(client, repo, deliveryBranch(issueNumber));
  const fixes: BranchProbe[] = [];
  let probe = await probeBranch(client, repo, cdFixBranch(issueNumber, 1));
  while (probe.exists || probe.pullRequests.length > 0) {
    fixes.push(probe);
    probe = await probeBranch(client, repo, cdFixBranch(issueNumber, fixes.length + 1));
  }
  return {
    delivery,
    fixes,
    current: fixes.at(-1) ?? delivery,
    nextFixBranch: probe.name,
  };
}
