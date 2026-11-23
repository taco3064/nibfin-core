import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import { isNibfinWorkflow } from "./nibfin-workflows.ts";
import type { Repo } from "./repo.ts";
import { type RunState, runState } from "./run-state.ts";

export interface WorkflowRunSummary {
  id: number;
  name: string;
  path: string;
  status: string | null;
  conclusion: string | null;
  state: RunState;
  url: string;
}

/** The push runs a merge commit triggered on its base branch. */
export interface CdState {
  mergeCommitSha: string;
  /**
   * True once a push run of Nibfin's own workflow exists for the merge commit: the
   * signal that GitHub has created the runs of that push.
   */
  nibfinRunPresent: boolean;
  /** The CD set: the newest run per workflow `path`, excluding Nibfin's workflows. */
  runs: WorkflowRunSummary[];
}

/** All push runs of `mergeCommitSha` on `baseRef`, split into Nibfin's and the CD set. */
export async function readCdRuns(
  client: GitHubClient,
  repo: Repo,
  baseRef: string,
  mergeCommitSha: string,
): Promise<CdState> {
  const where = `${repo.owner}/${repo.repo}@${mergeCommitSha}`;
  const runs = await read(`read push runs of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/actions/runs", {
      ...repo,
      event: "push",
      branch: baseRef,
      head_sha: mergeCommitSha,
      per_page: 100,
    }),
  );
  const pushRuns = runs.filter(
    (run) => run.event === "push" && run.head_sha === mergeCommitSha,
  );
  const newest = new Map<string, (typeof pushRuns)[number]>();
  for (const run of pushRuns.filter((candidate) => !isNibfinWorkflow(candidate.name))) {
    const current = newest.get(run.path);
    if (!current || run.id > current.id) {
      newest.set(run.path, run);
    }
  }
  return {
    mergeCommitSha,
    nibfinRunPresent: pushRuns.some((run) => isNibfinWorkflow(run.name)),
    runs: [...newest.values()].map((run) => ({
      id: run.id,
      name: run.name ?? "",
      path: run.path,
      status: run.status,
      conclusion: run.conclusion,
      state: runState(run.status, run.conclusion),
      url: run.html_url,
    })),
  };
}
