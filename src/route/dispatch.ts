import {
  type ActingClient,
  dispatchWorkflow,
  nibfinRunTitle,
  readNotStartedRuns,
  readRunnerLabels,
  type Repo,
  runnerLabel,
} from "../github/index.ts";
import type { IssueRoute } from "./route.ts";

/** The execution repository's workflow that runs every route and stage Job. */
export const sharedRunnerWorkflow = "nibfin-shared-runner.yml";

/** What a route or post-stage run dispatches with. */
export interface DispatchScope {
  client: ActingClient;
  /** The execution repository (`NIBFIN_RUN_REPO`). */
  runRepo: Repo;
  /** This run's id (`NIBFIN_RUN_ID`); never counted as a waiting duplicate. */
  runId: number | undefined;
  log: (line: string) => void;
}

const repoName = (repo: Repo) => `${repo.owner}/${repo.repo}`;

async function dispatch(
  scope: DispatchScope,
  title: string,
  inputs: Record<string, string>,
): Promise<void> {
  const url = await dispatchWorkflow(
    scope.client,
    scope.runRepo,
    sharedRunnerWorkflow,
    inputs,
  );
  scope.log(`Dispatched ${title}${url === undefined ? "" : `: ${url}`}`);
}

/** Dispatches a route run for the Issue; never deduplicated, so no wake is lost. */
export async function dispatchRoute(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
): Promise<void> {
  const inputs = { stage: "route", repo: repoName(repo), issue: String(issue) };
  await dispatch(scope, nibfinRunTitle(repo, issue, "route"), inputs);
}

/**
 * Dispatches the stage of `route` for the Issue (#720) only when a self-hosted runner
 * of the execution repository has the Assignee's label `nibfin-<user id>`
 * (case-insensitive, online or not, busy or not); without one the Issue is an
 * ordinary assignment and nothing is written. It also skips when a run of the
 * execution repository that has not started (`requested`, `waiting`, `pending`,
 * `queued`) already has its title; a waiting run reads GitHub when it starts.
 * Running runs never count. Returns whether it dispatched.
 */
export async function dispatchStage(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  route: IssueRoute,
): Promise<boolean> {
  const label = runnerLabel(route.assignee);
  if (!(await readRunnerLabels(scope.client, scope.runRepo)).has(label)) {
    scope.log(
      `${repoName(repo)}#${issue}: no runner of the execution repository has the ` +
        `label ${label}; an ordinary assignment, nothing dispatched`,
    );
    return false;
  }
  const title = nibfinRunTitle(repo, issue, route.stage);
  const waiting = (await readNotStartedRuns(scope.client, scope.runRepo)).find(
    (run) => run.id !== scope.runId && run.title === title,
  );
  if (waiting !== undefined) {
    scope.log(`Not dispatching ${title}: run ${waiting.id} is waiting to start`);
    return false;
  }
  await dispatch(scope, title, {
    stage: route.stage,
    repo: repoName(repo),
    issue: String(issue),
    reason: route.reason ?? "",
    assignee: String(route.assignee),
  });
  return true;
}
