import { type BaseCd, readBaseCd } from "./base-cd.ts";
import type { BranchProbe, IssueBranches, PullRequestSummary } from "./branches.ts";
import { type CdState, readCdRuns } from "./cd-runs.ts";
import type { Actor, GitHubClient } from "./client.ts";
import type { DependencyIssue } from "./dependencies.ts";
import { readIssueRecord } from "./issue-query.ts";
import { readPullRequest } from "./pull-request.ts";
import type { IssueRef, Repo } from "./repo.ts";
import { type CiState, readCi } from "./required-checks.ts";

/**
 * A pull request with the CI of an open one and the CD of a merged one, and GitHub's
 * `mergeable` for the open one of the current branch.
 */
export interface PullRequestState extends PullRequestSummary {
  ci: CiState | null;
  cd: CdState | null;
  /** `null` while GitHub computes it, and for every other pull request (not read). */
  mergeable: boolean | null;
}

export interface BranchState extends Omit<BranchProbe, "pullRequests"> {
  pullRequests: PullRequestState[];
}

export interface IssueSnapshot {
  issue: IssueRef & {
    state: "open" | "closed";
    stateReason: string | null;
    labels: string[];
    /** In GitHub's order. */
    assignees: Actor[];
    url: string;
  };
  /** Native Blocked by Issues, from any repository. */
  blockedBy: DependencyIssue[];
  branches: {
    delivery: BranchState;
    fixes: BranchState[];
    current: BranchState;
    nextFixBranch: string;
  };
  /** Every pull request of the Issue's branches, newest first. */
  pullRequests: PullRequestState[];
  /**
   * The base branch around the current branch's merged pull request, read only when
   * its CD has a failed run (see `readBaseCd`); `null` otherwise.
   */
  baseCd: BaseCd | null;
}

/** The CI, CD and pull request readers a snapshot is built from; replaceable. */
export interface SnapshotReaders {
  readCi: typeof readCi;
  readCdRuns: typeof readCdRuns;
  readPullRequest: typeof readPullRequest;
  readBaseCd: typeof readBaseCd;
}

export const defaultSnapshotReaders: SnapshotReaders = {
  readCi,
  readCdRuns,
  readPullRequest,
  readBaseCd,
};

/**
 * Everything the stage rules need about Issue `issueNumber`, read from GitHub: the Issue,
 * its Blocked by and its branches from the Issue record (one GraphQL query), then CI of
 * each open and CD of each merged pull request, and `mergeable` of the current
 * branch's open pull request (REST), and the base branch around a red merge of the
 * current branch (`readBaseCd`). Every list is read in full; any
 * failed read fails the whole snapshot with `GITHUB_READ_FAILED`.
 */
export async function readIssueSnapshot(
  client: GitHubClient,
  repo: Repo,
  issueNumber: number,
  deps: Partial<SnapshotReaders> = {},
): Promise<IssueSnapshot> {
  const readers = { ...defaultSnapshotReaders, ...deps };
  const record = await readIssueRecord(client, { ...repo, number: issueNumber });
  const branches = await withRunData(client, repo, record.branches, readers);
  const merged = branches.current.pullRequests.find((pull) => pull.merged);
  const cd = merged?.cd ?? null;
  const red = cd?.runs.some((run) => run.state === "failed") === true;
  const baseCd =
    red && merged !== undefined && cd !== null
      ? await readers.readBaseCd(client, repo, merged.baseRef, cd, issueNumber)
      : null;
  return {
    issue: {
      ...record.issue,
      state: record.state,
      stateReason: record.stateReason,
      labels: record.labels,
      assignees: record.assignees,
      url: record.url,
    },
    blockedBy: record.blockedBy,
    branches,
    pullRequests: [branches.delivery, ...branches.fixes]
      .flatMap((branch) => branch.pullRequests)
      .toSorted((a, b) => b.number - a.number),
    baseCd,
  };
}

async function withRunData(
  client: GitHubClient,
  repo: Repo,
  probes: IssueBranches,
  readers: SnapshotReaders,
): Promise<IssueSnapshot["branches"]> {
  const states = new Map<BranchProbe, BranchState>();
  const stateOf = async (probe: BranchProbe): Promise<BranchState> => {
    const known = states.get(probe);
    if (known) {
      return known;
    }
    const current = probe === probes.current;
    const pullRequests: PullRequestState[] = [];
    for (const pull of probe.pullRequests) {
      pullRequests.push(await pullRequestState(client, repo, pull, readers, current));
    }
    const state = { ...probe, pullRequests };
    states.set(probe, state);
    return state;
  };
  const delivery = await stateOf(probes.delivery);
  const fixes: BranchState[] = [];
  for (const fix of probes.fixes) {
    fixes.push(await stateOf(fix));
  }
  return {
    delivery,
    fixes,
    current: await stateOf(probes.current),
    nextFixBranch: probes.nextFixBranch,
  };
}

async function pullRequestState(
  client: GitHubClient,
  repo: Repo,
  pull: PullRequestSummary,
  readers: SnapshotReaders,
  current: boolean,
): Promise<PullRequestState> {
  const open = pull.state === "open";
  const mergeable =
    open && current
      ? (await readers.readPullRequest(client, repo, pull.number)).mergeable
      : null;
  const ci = open ? await readers.readCi(client, repo, pull.baseRef, pull.headSha) : null;
  const cd =
    pull.merged && pull.mergeCommitSha !== null
      ? await readers.readCdRuns(client, repo, pull.baseRef, pull.mergeCommitSha)
      : null;
  return { ...pull, ci, cd, mergeable };
}
