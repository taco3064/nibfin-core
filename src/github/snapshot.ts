import type { BranchProbe, IssueBranches, PullRequestSummary } from "./branches.ts";
import { type CdState, readCdRuns } from "./cd-runs.ts";
import type { Actor, GitHubClient } from "./client.ts";
import type { DependencyIssue } from "./dependencies.ts";
import { readIssueRecord } from "./issue-query.ts";
import type { IssueRef, Repo } from "./repo.ts";
import { type CiState, readCi } from "./required-checks.ts";

/** A pull request with the CI of an open one and the CD of a merged one. */
export interface PullRequestState extends PullRequestSummary {
  ci: CiState | null;
  cd: CdState | null;
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
}

/** The CI and CD readers a snapshot is built from; replaceable for callers. */
export interface SnapshotReaders {
  readCi: typeof readCi;
  readCdRuns: typeof readCdRuns;
}

export const defaultSnapshotReaders: SnapshotReaders = { readCi, readCdRuns };

/**
 * Everything the stage rules need about Issue `issueNumber`, read from GitHub: the Issue,
 * its Blocked by and its branches from the Issue record (one GraphQL query), then CI of
 * each open and CD of each merged pull request (REST). Every list is read in full; any
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
    const pullRequests: PullRequestState[] = [];
    for (const pull of probe.pullRequests) {
      pullRequests.push(await pullRequestState(client, repo, pull, readers));
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
): Promise<PullRequestState> {
  const ci =
    pull.state === "open"
      ? await readers.readCi(client, repo, pull.baseRef, pull.headSha)
      : null;
  const cd =
    pull.merged && pull.mergeCommitSha !== null
      ? await readers.readCdRuns(client, repo, pull.baseRef, pull.mergeCommitSha)
      : null;
  return { ...pull, ci, cd };
}
