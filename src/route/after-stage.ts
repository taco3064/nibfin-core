import { freshReads, type Repo } from "../github/index.ts";
import {
  type FixReason,
  NoProgressError,
  type NextActionRecord,
} from "../stages/index.ts";
import { type DispatchScope, dispatchRoute, dispatchStage } from "./dispatch.ts";
import { readRoute } from "./route.ts";

/** The stage that just exited 0, for one Issue. */
export interface FinishedStage {
  repo: Repo;
  issue: number;
  stage: "shape" | "deliver" | "review";
  reason: FixReason | null;
}

function parseRepo(name: string): Repo {
  const [owner, repo] = name.split("/");
  return { owner, repo };
}

function noProgress(finished: FinishedStage): NoProgressError {
  const what = `${finished.stage} (${finished.reason ?? "no reason"})`;
  // A conflict GitHub has not finished computing reads like the same conflict.
  const review = finished.stage === "review" || finished.reason === "conflict";
  const message =
    `The ${what} run changed nothing on GitHub, and GitHub state still asks for ` +
    `the same run${review ? "; GitHub may still be computing mergeability" : ""}.`;
  return new NoProgressError(message, review);
}

/**
 * After a stage exited 0 (#674): dispatches a route for each `wake` target first;
 * then, only while the Issue is open, its route result, deduplicated. When the run
 * made no progress and the route asks for the same stage and reason again, it stops
 * with `STAGE_NO_PROGRESS` instead (a person gets `pending`). A closed Issue's own
 * route is never dispatched here, so closing cannot loop.
 */
export async function continueAfterStage(
  scope: DispatchScope,
  finished: FinishedStage,
  record: NextActionRecord,
): Promise<void> {
  // The route reads the state the stage left, not what it read before.
  freshReads(scope.client);
  for (const target of record.wake ?? []) {
    await dispatchRoute(scope, parseRepo(target.repo), target.issue);
  }
  const { repo, issue } = finished;
  const state = await readRoute(scope.client, repo, issue, scope.log);
  if (!state.open) {
    scope.log(`${repo.owner}/${repo.repo}#${issue} is closed; nothing more to route`);
    return;
  }
  const { route } = state;
  if (route === null) {
    scope.log(`${repo.owner}/${repo.repo}#${issue}: nothing to run now`);
    return;
  }
  const same = route.stage === finished.stage && route.reason === finished.reason;
  if (same && !record.progressed) {
    throw noProgress(finished);
  }
  await dispatchStage(scope, repo, issue, route);
}
