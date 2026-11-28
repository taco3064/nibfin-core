import { issueOfBranch } from "./branches.ts";
import { type CdState, readCdRuns } from "./cd-runs.ts";
import type { GitHubClient } from "./client.ts";
import { absentProbe, read, readOptional } from "./errors.ts";
import { readIssueRecord } from "./issue-query.ts";
import { readPullRequestsMergedAt } from "./pull-request.ts";
import type { Repo } from "./repo.ts";

/** How many push heads of the base branch one read lists (one page). */
export const baseHeadPage = 100;

/**
 * The push heads of `baseRef`, newest first: one page of the runs of Nibfin's push
 * workflow (`nibfinWorkflowId`), which runs once on every push to the base branch
 * (R3.35), so other workflows' runs take no slot. Sorted by run id, newest first,
 * one SHA per run (a repeated SHA keeps its newest run).
 */
export async function readBaseHeads(
  client: GitHubClient,
  repo: Repo,
  baseRef: string,
  nibfinWorkflowId: number,
): Promise<string[]> {
  const operation = `list push heads of ${repo.owner}/${repo.repo}@${baseRef}`;
  const { data } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
      ...repo,
      workflow_id: nibfinWorkflowId,
      event: "push",
      branch: baseRef,
      per_page: baseHeadPage,
    }),
  );
  const runs = data.workflow_runs
    .filter((run) => run.event === "push" && run.head_branch === baseRef)
    .toSorted((a, b) => Number(b.id) - Number(a.id));
  return [...new Set(runs.map((run) => run.head_sha))];
}

/**
 * Whether commit `head` contains commit `base` (`base` is its ancestor or equal):
 * `GET /compare/{base}...{head}` answers `ahead` or `identical` (#795). `behind`,
 * `diverged` and a commit GitHub does not know (404) do not contain it; another
 * failure fails the read. Never judged by time or run order.
 */
export async function containsCommit(
  client: GitHubClient,
  repo: Repo,
  base: string,
  head: string,
): Promise<boolean> {
  const where = `${repo.owner}/${repo.repo} ${base}...${head}`;
  const answer = await readOptional(`compare ${where}`, () =>
    client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      ...repo,
      basehead: `${base}...${head}`,
      per_page: 1,
      request: absentProbe,
    }),
  );
  const status = answer?.data.status;
  return status === "ahead" || status === "identical";
}

/**
 * The Issues of the open or merged pull requests of `GET /commits/{sha}/pulls` whose
 * head is `nibfin/issue-<n>[-cd-<k>]` (the head ref stays after the branch is
 * deleted), in GitHub's order, without repeats.
 */
async function associatedIssues(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<number[]> {
  const operation = `list pull requests of ${repo.owner}/${repo.repo}@${sha}`;
  const pulls = await read(operation, () =>
    client.paginate("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
      ...repo,
      commit_sha: sha,
      per_page: 100,
    }),
  );
  const issues = pulls
    .filter((pull) => pull.state === "open" || pull.merged_at !== null)
    .map((pull) => issueOfBranch(pull.head.ref))
    .filter((issue) => issue !== undefined);
  return [...new Set(issues)];
}

/**
 * The Issue whose pull request introduced commit `sha`: the first Issue of
 * `GET /commits/{sha}/pulls` (see `associatedIssues`). `undefined` when it belongs to
 * no Issue.
 */
export async function issueOfCommit(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<number | undefined> {
  return (await associatedIssues(client, repo, sha))[0];
}

/**
 * Every Issue of commit `sha`, without repeats: those of `GET /commits/{sha}/pulls`
 * (see `associatedIssues`), then those of every merged pull request whose
 * `merge_commit_sha` is the commit (a pull request that merged without moving the
 * base is not associated with it, #771). Empty when it belongs to no Issue.
 */
export async function issuesOfCommit(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<number[]> {
  const issues = await associatedIssues(client, repo, sha);
  for (const pull of await readPullRequestsMergedAt(client, repo, sha)) {
    const issue = issueOfBranch(pull.headRef);
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
  return [...new Set(issues)];
}

/** An Issue's state and the merge commit of its newest merged pull request. */
export interface NewestMerge {
  number: number;
  open: boolean;
  /** Newest by pull request number across the Issue's branches; `null` for none. */
  merge: { sha: string; pullRequestUrl: string } | null;
}

/** Reads Issue `issue`'s state and newest merge (see `NewestMerge`). */
export async function newestMergeOf(
  client: GitHubClient,
  repo: Repo,
  issue: number,
): Promise<NewestMerge> {
  const record = await readIssueRecord(client, { ...repo, number: issue });
  const { delivery, fixes } = record.branches;
  const merged = [delivery, ...fixes]
    .flatMap((branch) => branch.pullRequests)
    .filter((pull) => pull.merged && pull.mergeCommitSha !== null)
    .toSorted((a, b) => b.number - a.number);
  const newest = merged[0];
  return {
    number: issue,
    open: record.state === "open",
    merge:
      newest === undefined
        ? null
        : { sha: newest.mergeCommitSha!, pullRequestUrl: newest.url },
  };
}

/** The previous Issue's newest merge after its red push: its fix `F`. */
export interface PreviousFix {
  mergeCommitSha: string;
  pullRequestUrl: string;
  /** True when F is a push head on the page newer than the Issue's own merge. */
  newerThanMerge: boolean;
  /** True when F contains the Issue's own merge (see `containsCommit`). */
  containsMerge: boolean;
  cd: CdState;
}

/** The Issue of the red push just before the Issue's own merge. */
export interface PreviousIssue {
  number: number;
  open: boolean;
  /**
   * Its newest merge when that is not the red previous push (read whether the Issue
   * is open or closed); `null` while it merged nothing after that push. Not read
   * when the previous Issue is the Issue itself.
   */
  fix: PreviousFix | null;
}

/** The base branch around an Issue's red merge `M` (see `readBaseCd`). */
export interface BaseCd {
  /** The push heads of the base branch, newest first (one page). */
  heads: string[];
  /**
   * The CD of the newest head, when M is on the page, is not the newest, and the
   * newest head contains M (see `containsCommit`); `null` otherwise.
   */
  newest: CdState | null;
  /** The CD of the head just older than M, when M is on the page and has one. */
  previous: CdState | null;
  /** Only when `previous` has a failed run and its commit belongs to an Issue. */
  previousIssue: PreviousIssue | null;
}

/**
 * Reads the base branch around the Issue's own merge `M` (`ownCd`): the push heads,
 * the CD of the newest head when it contains M and of M's predecessor, and when that
 * predecessor is red, its Issue and that Issue's newer merge with its CD. `null` without
 * the workflow id of Nibfin's push run on M (nothing to list heads by).
 */
export async function readBaseCd(
  client: GitHubClient,
  repo: Repo,
  baseRef: string,
  ownCd: CdState,
  issueNumber: number,
): Promise<BaseCd | null> {
  if (ownCd.nibfinWorkflowId === undefined) {
    return null;
  }
  const heads = await readBaseHeads(client, repo, baseRef, ownCd.nibfinWorkflowId);
  const at = heads.indexOf(ownCd.mergeCommitSha);
  if (at === -1) {
    return { heads, newest: null, previous: null, previousIssue: null };
  }
  const cdOf = (sha: string) => readCdRuns(client, repo, baseRef, sha);
  const contains = (sha: string) =>
    containsCommit(client, repo, ownCd.mergeCommitSha, sha);
  const newest = at !== 0 && (await contains(heads[0])) ? await cdOf(heads[0]) : null;
  const previousSha = heads[at + 1];
  const previous = previousSha === undefined ? null : await cdOf(previousSha);
  const red = previous?.runs.some((run) => run.state === "failed") === true;
  if (!red) {
    return { heads, newest, previous, previousIssue: null };
  }
  const number = await issueOfCommit(client, repo, previousSha);
  if (number === undefined) {
    return { heads, newest, previous, previousIssue: null };
  }
  if (number === issueNumber) {
    return { heads, newest, previous, previousIssue: { number, open: true, fix: null } };
  }
  const { open, merge } = await newestMergeOf(client, repo, number);
  if (merge === null || merge.sha === previousSha) {
    return { heads, newest, previous, previousIssue: { number, open, fix: null } };
  }
  const index = heads.indexOf(merge.sha);
  const fix: PreviousFix = {
    mergeCommitSha: merge.sha,
    pullRequestUrl: merge.pullRequestUrl,
    newerThanMerge: index !== -1 && index < at,
    containsMerge: await contains(merge.sha),
    cd: await cdOf(merge.sha),
  };
  return { heads, newest, previous, previousIssue: { number, open, fix } };
}
