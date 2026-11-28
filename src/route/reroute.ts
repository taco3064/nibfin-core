import type { Repo } from "../github/index.ts";
import { describeStage } from "../stages/index.ts";
import { type DispatchScope, dispatchStage } from "./dispatch.ts";
import { readRoute } from "./route.ts";

/**
 * After the repair stage removed `pending` (the route Job, #777, or the repair Job,
 * #778): reads the Issue's route again and dispatches it once (Proposal R4.42), or
 * logs that nothing runs.
 */
export async function rerouteIssue(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
): Promise<void> {
  const state = await readRoute(scope.client, repo, issue, scope.log);
  if (state.route === null) {
    const name = `${repo.owner}/${repo.repo}#${issue}`;
    scope.log(`${name}: nothing to run (${describeStage(state.stage)})`);
  } else {
    await dispatchStage(scope, repo, issue, state.route);
  }
}
