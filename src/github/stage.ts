import type { WorkflowRunSummary } from "./cd-runs.ts";
import type { DependencyIssue } from "./dependencies.ts";
import { nibfinLabels } from "./labels.ts";
import type { RequiredCheck, RequiredCheckResult } from "./required-checks.ts";
import type { RunState } from "./run-state.ts";
import type { IssueSnapshot, PullRequestState } from "./snapshot.ts";

export type IneligibleReason =
  "closed" | "no-scope" | "paused" | "pending" | "blocked" | "no-assignee";

export type CiStage = "review" | "awaiting-ci" | "ci-failed";

/** Where the delivery of a shaped Issue stands, from its branches, PRs, CI and CD. */
export type DeliveryOutcome =
  | { stage: "deliver"; branch: string }
  /** The open PR conflicts with its base: GitHub runs no CI for it. */
  | { stage: "conflict"; branch: string; pullRequest: PullRequestState }
  | {
      stage: CiStage;
      branch: string;
      pullRequest: PullRequestState;
      /** For the merge admission (#673). */
      requiredChecks: RequiredCheck[];
      results: RequiredCheckResult[];
    }
  | {
      stage: "awaiting-cd";
      reason: "nibfin-push-run-missing" | "cd-runs-pending";
      branch: string;
      pullRequest: PullRequestState;
      runs: WorkflowRunSummary[];
    }
  | {
      stage: "cd-failed";
      branch: string;
      pullRequest: PullRequestState;
      runs: WorkflowRunSummary[];
      /** The branch the CD-failure fix uses, cut from the latest base. */
      nextFixBranch: string;
    }
  | { stage: "done"; branch: string; pullRequest: PullRequestState };

export type Stage =
  | { stage: "ineligible"; reason: Exclude<IneligibleReason, "blocked"> }
  | { stage: "ineligible"; reason: "blocked"; blockers: DependencyIssue[] }
  | { stage: "shape" }
  | DeliveryOutcome;

/**
 * The stage of an Issue: the ineligible checks first, then the `shaped` rule, then the
 * delivery outcome.
 */
export function deriveStage(snapshot: IssueSnapshot): Stage {
  const { issue } = snapshot;
  const has = (label: string) => issue.labels.includes(label);
  if (issue.state === "closed") {
    return { stage: "ineligible", reason: "closed" };
  }
  if (!has(nibfinLabels.scope)) {
    return { stage: "ineligible", reason: "no-scope" };
  }
  if (has(nibfinLabels.pause)) {
    return { stage: "ineligible", reason: "paused" };
  }
  if (has(nibfinLabels.pending)) {
    return { stage: "ineligible", reason: "pending" };
  }
  const blockers = snapshot.blockedBy.filter((dependency) => !isResolved(dependency));
  if (blockers.length > 0) {
    return { stage: "ineligible", reason: "blocked", blockers };
  }
  if (issue.assignees.length === 0) {
    return { stage: "ineligible", reason: "no-assignee" };
  }
  if (!has(nibfinLabels.shaped)) {
    return { stage: "shape" };
  }
  return deliveryOutcome(snapshot);
}

/** An upstream Issue is resolved only when it is Closed and has `delivered`. */
function isResolved(dependency: DependencyIssue): boolean {
  return (
    dependency.state === "closed" && dependency.labels.includes(nibfinLabels.delivered)
  );
}

/**
 * The PR, CI, CD and fix-branch rules on the current branch (the highest fix branch,
 * else the delivery branch). No label or Issue-state checks. An open PR that GitHub
 * finds not mergeable is `conflict` before any CI rule, since it gets no CI.
 */
export function deliveryOutcome(snapshot: IssueSnapshot): DeliveryOutcome {
  const branch = snapshot.branches.current;
  const open = branch.pullRequests.find((pull) => pull.state === "open");
  if (open?.mergeable === false) {
    return { stage: "conflict", branch: branch.name, pullRequest: open };
  }
  if (open) {
    return ciOutcome(branch.name, open);
  }
  const merged = branch.pullRequests.find((pull) => pull.merged);
  if (merged) {
    return cdOutcome(branch.name, merged, snapshot.branches.nextFixBranch);
  }
  return { stage: "deliver", branch: branch.name };
}

function ciOutcome(branch: string, pullRequest: PullRequestState): DeliveryOutcome {
  const requiredChecks = pullRequest.ci?.requiredChecks ?? [];
  const results = pullRequest.ci?.results ?? [];
  const outcome = { branch, pullRequest, requiredChecks, results };
  if (pullRequest.ci === null) {
    return { stage: "awaiting-ci", ...outcome };
  }
  if (requiredChecks.length === 0) {
    return { stage: "review", ...outcome };
  }
  const states = requiredChecks.map((check) => resultOf(check, results));
  return { stage: ciStage(states), ...outcome };
}

function resultOf(check: RequiredCheck, results: RequiredCheckResult[]): RunState {
  const result = results.find(
    (candidate) =>
      candidate.context === check.context &&
      candidate.integrationId === check.integrationId,
  );
  return result?.state ?? "pending";
}

function ciStage(states: RunState[]): CiStage {
  if (states.includes("failed")) {
    return "ci-failed";
  }
  return states.includes("pending") ? "awaiting-ci" : "review";
}

function cdOutcome(
  branch: string,
  pullRequest: PullRequestState,
  nextFixBranch: string,
): DeliveryOutcome {
  const runs = pullRequest.cd?.runs ?? [];
  if (!pullRequest.cd?.nibfinRunPresent) {
    return {
      stage: "awaiting-cd",
      reason: "nibfin-push-run-missing",
      branch,
      pullRequest,
      runs,
    };
  }
  const states = runs.map((run) => run.state);
  if (states.includes("failed")) {
    return { stage: "cd-failed", branch, pullRequest, runs, nextFixBranch };
  }
  if (states.includes("pending")) {
    return { stage: "awaiting-cd", reason: "cd-runs-pending", branch, pullRequest, runs };
  }
  return { stage: "done", branch, pullRequest };
}
