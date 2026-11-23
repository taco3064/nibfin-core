import {
  type BranchProbe,
  type IssueBranches,
  type PullRequestSummary,
  readIssueBranches,
} from "./branches.ts";
import { type CdState, readCdRuns } from "./cd-runs.ts";
import type { Actor, GitHubClient } from "./client.ts";
import { type DependencyIssue, readBlockedBy } from "./dependencies.ts";
import { GitHubError, read } from "./errors.ts";
import { formatIssue, type IssueRef, labelNames, type Repo } from "./repo.ts";
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

/** The readers a snapshot is built from; replaceable for callers that need to. */
export interface SnapshotReaders {
  readIssueBranches: typeof readIssueBranches;
  readCi: typeof readCi;
  readCdRuns: typeof readCdRuns;
  readBlockedBy: typeof readBlockedBy;
}

export const defaultSnapshotReaders: SnapshotReaders = {
  readIssueBranches,
  readCi,
  readCdRuns,
  readBlockedBy,
};

/**
 * Everything the stage rules need about Issue `issueNumber`, read from GitHub. Every list
 * is read in full; any failed read fails the whole snapshot with `GITHUB_READ_FAILED`.
 */
export async function readIssueSnapshot(
  client: GitHubClient,
  repo: Repo,
  issueNumber: number,
  deps: Partial<SnapshotReaders> = {},
): Promise<IssueSnapshot> {
  const readers = { ...defaultSnapshotReaders, ...deps };
  const ref: IssueRef = { ...repo, number: issueNumber };
  const operation = `read ${formatIssue(ref)}`;
  const { data } = await read(operation, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      ...repo,
      issue_number: issueNumber,
    }),
  );
  if (data.pull_request) {
    throw new GitHubError(
      "GITHUB_READ_FAILED",
      operation,
      new Error(`${formatIssue(ref)} is a pull request`),
    );
  }
  const blockedBy = await readers.readBlockedBy(
    client,
    ref,
    data.issue_dependencies_summary?.total_blocked_by,
  );
  const probes = await readers.readIssueBranches(client, repo, issueNumber);
  const branches = await withRunData(client, repo, probes, readers);
  return {
    issue: {
      ...ref,
      state: data.state === "closed" ? "closed" : "open",
      stateReason: data.state_reason ?? null,
      labels: labelNames(data.labels),
      assignees: (data.assignees ?? []).map((user) => ({
        id: Number(user.id),
        login: user.login,
      })),
      url: data.html_url,
    },
    blockedBy,
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
