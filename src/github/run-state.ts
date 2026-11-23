/** The result of a check run, commit status or workflow run for the stage rules. */
export type RunState = "success" | "failed" | "pending";

const successConclusions = new Set(["success", "neutral", "skipped"]);
const failedConclusions = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "startup_failure",
  "stale",
]);

/**
 * A check run or workflow run: only a `completed` run has a result. `action_required`,
 * a missing conclusion and any conclusion GitHub adds later count as pending.
 */
export function runState(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): RunState {
  if (status !== "completed" || typeof conclusion !== "string") {
    return "pending";
  }
  if (successConclusions.has(conclusion)) {
    return "success";
  }
  return failedConclusions.has(conclusion) ? "failed" : "pending";
}

/** A commit status: `error` and `failure` fail, `success` succeeds. */
export function commitStatusState(state: string): RunState {
  if (state === "success") {
    return "success";
  }
  return state === "error" || state === "failure" ? "failed" : "pending";
}
