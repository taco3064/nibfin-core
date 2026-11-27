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
  /**
   * The `workflow_id` of Nibfin's push workflow on this push: the one at
   * `nibfinPushWorkflowPath` when several Nibfin workflows ran, else the lowest id.
   * Absent while no Nibfin run exists.
   */
  nibfinWorkflowId?: number;
}

/** Nibfin's workflow that runs on every push to the base branch (R3.35, R5.2). */
export const nibfinPushWorkflowPath = ".github/workflows/nibfin-issue.yml";

/**
 * The workflow id of Nibfin's push workflow among Nibfin's own `runs`; a run without
 * a numeric `workflow_id` is not counted.
 */
function nibfinWorkflowIdOf(
  runs: ReadonlyArray<{ path: string; workflow_id?: unknown }>,
): number | undefined {
  const known = runs.flatMap((run) =>
    typeof run.workflow_id === "number" ? [{ path: run.path, id: run.workflow_id }] : [],
  );
  const push = known.find((run) => run.path === nibfinPushWorkflowPath);
  if (push !== undefined) {
    return push.id;
  }
  return known.length === 0 ? undefined : Math.min(...known.map((run) => run.id));
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
  const nibfinRuns = pushRuns.filter((run) => isNibfinWorkflow(run.name));
  const nibfinWorkflowId = nibfinWorkflowIdOf(nibfinRuns);
  return {
    mergeCommitSha,
    nibfinRunPresent: nibfinRuns.length > 0,
    ...(nibfinWorkflowId === undefined ? {} : { nibfinWorkflowId }),
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
