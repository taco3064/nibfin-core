import type { BaseCd } from "./base-cd.ts";
import type { CdState, WorkflowRunSummary } from "./cd-runs.ts";
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
      reason: AwaitingCdReason;
      branch: string;
      pullRequest: PullRequestState;
      runs: WorkflowRunSummary[];
      /** The Issue whose merge or fix this one waits for, when it is known. */
      waitingOn?: number;
    }
  | {
      stage: "cd-failed";
      branch: string;
      pullRequest: PullRequestState;
      /** The runs that decided the fix; their failed ones are what to fix. */
      runs: WorkflowRunSummary[];
      /**
       * The merge commit `runs` belong to and its pull request, when it is not
       * `pullRequest`'s merge: another Issue's fix on a newer base head.
       */
      failedOn?: { mergeCommitSha: string; pullRequestUrl: string };
      /** The branch the CD-failure fix uses, cut from the latest base. */
      nextFixBranch: string;
    }
  | {
      stage: "done";
      branch: string;
      pullRequest: PullRequestState;
      /** A newer base head whose CD passed for this merge, which itself was red. */
      passedOn?: CdState;
    };

/**
 * Why a merged Issue waits for CD: no Nibfin push run yet; CD runs still pending;
 * the push before its red merge still runs CD; that push is red and its open Issue
 * has not merged a fix since; or that Issue's fix has no complete CD on a newer head.
 */
export type AwaitingCdReason =
  | "nibfin-push-run-missing"
  | "cd-runs-pending"
  | "previous-cd-pending"
  | "previous-cd-red"
  | "previous-fix-cd-pending";

export type Stage =
  | { stage: "ineligible"; reason: Exclude<IneligibleReason, "blocked"> }
  | { stage: "ineligible"; reason: "blocked"; blockers: DependencyIssue[] }
  /** An open `request` without `scope`: the Scope stage (Proposal R4.8). */
  | { stage: "scope" }
  | { stage: "shape" }
  | DeliveryOutcome;

/**
 * The stage of an Issue: the ineligible checks first (an Issue with neither `scope`
 * nor `request` is `no-scope`), then a `request` without `scope` is `scope`, then the
 * `shaped` rule, then the delivery outcome. An Issue with `scope` takes the same path
 * whether it has `request` or not.
 */
export function deriveStage(snapshot: IssueSnapshot): Stage {
  const { issue } = snapshot;
  const has = (label: string) => issue.labels.includes(label);
  if (issue.state === "closed") {
    return { stage: "ineligible", reason: "closed" };
  }
  if (!has(nibfinLabels.scope) && !has(nibfinLabels.request)) {
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
  if (!has(nibfinLabels.scope)) {
    return { stage: "scope" };
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
    const { nextFixBranch } = snapshot.branches;
    const base = { branch: branch.name, pullRequest: merged, nextFixBranch };
    return cdOutcome(base, snapshot.baseCd, snapshot.issue.number);
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

interface CdBase {
  branch: string;
  pullRequest: PullRequestState;
  nextFixBranch: string;
}

/**
 * The CD of the current branch's merged pull request `M`: waiting while Nibfin's
 * push run is missing; then a red M goes to `redMergeOutcome`; then waiting while
 * runs are pending; else `done`.
 */
function cdOutcome(
  base: CdBase,
  baseCd: BaseCd | null,
  issueNumber: number,
): DeliveryOutcome {
  const { branch, pullRequest } = base;
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
    return redMergeOutcome(base, pullRequest.cd, baseCd, issueNumber);
  }
  if (states.includes("pending")) {
    return { stage: "awaiting-cd", reason: "cd-runs-pending", branch, pullRequest, runs };
  }
  return { stage: "done", branch, pullRequest };
}

type CdStatus = "pending" | "failed" | "green";

/** A failed run makes a CD red even while others run; no Nibfin run is pending. */
function cdStatus(cd: CdState): CdStatus {
  if (!cd.nibfinRunPresent) {
    return "pending";
  }
  const states = cd.runs.map((run) => run.state);
  if (states.includes("failed")) {
    return "failed";
  }
  return states.includes("pending") ? "pending" : "green";
}

/**
 * Whether a newer head `head` passes for merge `merge`: its CD is complete with
 * no failure, and every workflow that failed on the merge ran again there and
 * succeeded (a `paths:`-filtered workflow that did not run does not pass).
 */
function passesFor(head: CdState, merge: CdState): boolean {
  return cdStatus(head) === "green" && missingPaths(head, merge).length === 0;
}

/** The failed runs of `merge` whose path has no successful run on `head`. */
function missingPaths(head: CdState, merge: CdState): WorkflowRunSummary[] {
  return merge.runs.filter(
    (run) =>
      run.state === "failed" &&
      !head.runs.some(
        (candidate) => candidate.path === run.path && candidate.state === "success",
      ),
  );
}

/**
 * A red own merge `M` (#772): only the Issue whose merge made the base red fixes it.
 * 1. The newest head contains M and passes for M → `done` (`passedOn`); a head
 *    that does not contain M is never used (`BaseCd.newest` is `null`, #795).
 * 2. M's predecessor is unknown or green, or red with no Issue or with this Issue →
 *    fix M's runs.
 * 3. The predecessor still runs CD → wait.
 * 4. The predecessor's Issue merged nothing since: open → wait for it; closed → fix.
 * 5. That Issue's newer merge F (open or closed): not yet a newer head with Nibfin's
 *    run → wait; red → fix F's runs; pending → wait; contains and passes for M →
 *    `done`; green but not containing M → fix M's runs; green but missing a path that
 *    failed on M → fix M's runs on those paths.
 * Without `baseCd` (no head list) M is fixed, as before.
 */
function redMergeOutcome(
  base: CdBase,
  own: CdState,
  baseCd: BaseCd | null,
  issueNumber: number,
): DeliveryOutcome {
  const { branch, pullRequest, nextFixBranch } = base;
  const fixOwn: DeliveryOutcome = {
    stage: "cd-failed",
    branch,
    pullRequest,
    runs: own.runs,
    nextFixBranch,
  };
  const wait = (reason: AwaitingCdReason, waitingOn?: number): DeliveryOutcome => ({
    stage: "awaiting-cd",
    reason,
    branch,
    pullRequest,
    runs: own.runs,
    ...(waitingOn === undefined ? {} : { waitingOn }),
  });
  if (baseCd === null) {
    return fixOwn;
  }
  const { newest, previous, previousIssue } = baseCd;
  if (newest !== null && passesFor(newest, own)) {
    return { stage: "done", branch, pullRequest, passedOn: newest };
  }
  if (previous === null) {
    return fixOwn;
  }
  const status = cdStatus(previous);
  if (status === "green") {
    return fixOwn;
  }
  if (status === "pending") {
    return wait("previous-cd-pending");
  }
  if (previousIssue === null || previousIssue.number === issueNumber) {
    return fixOwn;
  }
  const { fix, number } = previousIssue;
  if (fix === null) {
    return previousIssue.open ? wait("previous-cd-red", number) : fixOwn;
  }
  if (!fix.newerThanMerge) {
    return wait("previous-fix-cd-pending", number);
  }
  const fixStatus = cdStatus(fix.cd);
  if (fixStatus === "failed") {
    const failedOn = {
      mergeCommitSha: fix.mergeCommitSha,
      pullRequestUrl: fix.pullRequestUrl,
    };
    return { ...fixOwn, runs: fix.cd.runs, failedOn };
  }
  if (fixStatus === "pending") {
    return wait("previous-fix-cd-pending", number);
  }
  if (!fix.containsMerge) {
    return fixOwn;
  }
  const missing = missingPaths(fix.cd, own);
  if (missing.length === 0) {
    return { stage: "done", branch, pullRequest, passedOn: fix.cd };
  }
  return { ...fixOwn, runs: missing };
}
