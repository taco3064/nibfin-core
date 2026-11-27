import {
  type ActingClient,
  deliveryBranch,
  deriveStage,
  findMarkedComment,
  freshReads,
  type IssueRef,
  type IssueSnapshot,
  type MarkedComment,
  type PullRequestState,
  readIssueSnapshot,
  type RequiredCheckResult,
  type Stage,
  type WorkflowRunSummary,
} from "../github/index.ts";
import type { FixReason, JobContext } from "./context.ts";
import { readCurrentShape } from "./shape-wrong.ts";

/** The comment key of the Shape review on a pull request (#673). */
export const reviewCommentKey = "review";

/** What a fix run fixes, as GitHub shows it. */
export type FixPointer =
  | { reason: "ci-failure"; pullRequest: PullRequestState; failed: RequiredCheckResult[] }
  | { reason: "review"; pullRequest: PullRequestState; comment: MarkedComment }
  | { reason: "conflict"; pullRequest: PullRequestState }
  | {
      reason: "cd-failure";
      /**
       * The merge commit whose failed runs decided the fix and its pull request:
       * the Issue's own merge, or another Issue's fix on a newer base head (#772).
       * Both are absent when no merged pull request with a failed CD run is found.
       */
      failedOn: { mergeCommitSha: string; pullRequestUrl: string } | undefined;
      failed: WorkflowRunSummary[];
    };

export type Eligibility =
  | {
      eligible: true;
      snapshot: IssueSnapshot;
      branch: string;
      /** The open pull request of `branch`; its update waits for Accept. */
      openPull: PullRequestState | undefined;
      fix: FixPointer | undefined;
    }
  | {
      eligible: false;
      description: string;
      snapshot: IssueSnapshot;
      /** The derived stage, which did not fit the Job's reason. */
      stage: Stage;
    };

/** The derived stage as logged, with the reason of an ineligible one. */
export function describeStage(stage: Stage): string {
  return stage.stage === "ineligible" ? `ineligible (${stage.reason})` : stage.stage;
}

/** The head SHA a review comment records on its `Reviewed head: <sha>` line. */
export function reviewedHead(body: string): string | undefined {
  return /^Reviewed head: ([0-9a-f]{7,64})\s*$/m.exec(body)?.[1];
}

/** The Shape version a review comment records on its `Reviewed Shape: <v>` line. */
export function reviewedShape(body: string): string | undefined {
  return /^Reviewed Shape: (\d+\.\d+)\s*$/m.exec(body)?.[1];
}

/** The actor's review comment for the current head of a pull request. */
export interface HeadReview {
  comment: MarkedComment;
  /** It also records the current Shape version, so it still counts. */
  current: boolean;
}

/**
 * The actor's marked `review` comment on `pull` when it records the pull request's
 * current head, and whether it records the current Shape version too (read here).
 * A comment without a `Reviewed Shape` line is stale.
 */
export async function currentReview(
  client: ActingClient,
  issue: IssueRef,
  pull: PullRequestState,
): Promise<HeadReview | undefined> {
  const target = { owner: issue.owner, repo: issue.repo, number: pull.number };
  const comment = await findMarkedComment(
    client,
    target,
    reviewCommentKey,
    "pull-request",
  );
  if (comment === undefined || reviewedHead(comment.body) !== pull.headSha) {
    return undefined;
  }
  const shape = await readCurrentShape(client, issue);
  const recorded = reviewedShape(comment.body);
  return { comment, current: recorded !== undefined && recorded === shape?.version };
}

const failedRuns = (runs: WorkflowRunSummary[]) =>
  runs.filter((run) => run.state === "failed");

/** The newest merged pull request of the Issue whose CD failed, with the failed runs. */
function failedCd(snapshot: IssueSnapshot) {
  for (const pull of snapshot.pullRequests) {
    const failed = failedRuns(pull.cd?.runs ?? []);
    if (failed.length > 0) {
      // Failed runs come from a read CD, so the pull request has one.
      const failedOn = {
        mergeCommitSha: pull.cd!.mergeCommitSha,
        pullRequestUrl: pull.url,
      };
      return { failedOn, failed };
    }
  }
  return { failedOn: undefined, failed: [] };
}

/** At `cd-failed`: the runs the stage rule chose and the merge they belong to. */
function stageCd(stage: Extract<Stage, { stage: "cd-failed" }>) {
  const { pullRequest } = stage;
  // `cd-failed` is derived from the merged pull request's read CD.
  const failedOn = stage.failedOn ?? {
    mergeCommitSha: pullRequest.cd!.mergeCommitSha,
    pullRequestUrl: pullRequest.url,
  };
  return { failedOn, failed: failedRuns(stage.runs) };
}

type Decision = Omit<Extract<Eligibility, { eligible: true }>, "eligible" | "snapshot">;

async function decide(
  client: ActingClient,
  context: JobContext,
  snapshot: IssueSnapshot,
  stage: Stage,
): Promise<Decision | undefined> {
  const reason: FixReason | undefined = context.reason;
  if (reason === undefined) {
    return stage.stage === "deliver"
      ? { branch: stage.branch, openPull: undefined, fix: undefined }
      : undefined;
  }
  if (reason === "ci-failure" && stage.stage === "ci-failed") {
    const failed = stage.results.filter((result) => result.state === "failed");
    const pull = stage.pullRequest;
    const fix = { reason, pullRequest: pull, failed };
    return { branch: stage.branch, openPull: pull, fix };
  }
  if (reason === "conflict" && stage.stage === "conflict") {
    const pull = stage.pullRequest;
    return { branch: stage.branch, openPull: pull, fix: { reason, pullRequest: pull } };
  }
  if (reason === "review" && stage.stage === "review") {
    const pull = stage.pullRequest;
    const issue = { ...context.repo, number: context.issue };
    const review = await currentReview(client, issue, pull);
    if (review === undefined || !review.current) {
      return undefined;
    }
    return {
      branch: stage.branch,
      openPull: pull,
      fix: { reason, pullRequest: pull, comment: review.comment },
    };
  }
  if (reason === "cd-failure") {
    if (stage.stage === "cd-failed") {
      const fix = { reason, ...stageCd(stage) };
      return { branch: stage.nextFixBranch, openPull: undefined, fix };
    }
    if (stage.stage === "deliver" && stage.branch !== deliveryBranch(context.issue)) {
      const fix = { reason, ...failedCd(snapshot) };
      return { branch: stage.branch, openPull: undefined, fix };
    }
  }
  return undefined;
}

/**
 * Whether the Issue is at the Deliver stage for the Job's reason, and on which branch:
 * no reason → `deliver`; `ci-failure` → `ci-failed`; `review` → `review` with a
 * marked review comment that records the current PR head and the current Shape
 * version; `cd-failure` → `cd-failed` (on `nextFixBranch`), or `deliver` on a fix
 * branch (a redo); `conflict` → `conflict` (the open PR conflicts with its base).
 */
export async function readEligibility(
  client: ActingClient,
  context: JobContext,
  wait: (ms: number) => Promise<void>,
): Promise<Eligibility> {
  let read = await readOnce(client, context);
  for (let reads = 1; read.computing && reads < conflictReads; reads += 1) {
    await wait(conflictDelayMs);
    freshReads(client);
    read = await readOnce(client, context);
  }
  return read.eligibility;
}

/** One read of eligibility, and whether a conflict fix waits on GitHub computing. */
async function readOnce(
  client: ActingClient,
  context: JobContext,
): Promise<{ eligibility: Eligibility; computing: boolean }> {
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  const decision = await decide(client, context, snapshot, stage);
  if (decision !== undefined) {
    return { eligibility: { eligible: true, snapshot, ...decision }, computing: false };
  }
  const computing = context.reason === "conflict" ? computingPull(snapshot) : undefined;
  const reason = context.reason ?? "no reason";
  const note =
    computing === undefined
      ? ""
      : `; GitHub has not computed whether ${computing.url} conflicts with its base yet`;
  const description = `${describeStage(stage)} (${reason})${note}`;
  return {
    eligibility: { eligible: false, description, snapshot, stage },
    computing: computing !== undefined,
  };
}

/**
 * Reads of a conflict fix's eligibility while GitHub answers `mergeable: null`: the
 * first and 3 re-reads (#751, Proposal R4.37). `null` means GitHub is still computing,
 * not that the conflict is gone, so it must not decide the stage.
 */
export const conflictReads = 4;
export const conflictDelayMs = 3000;

/** The current branch's open pull request while GitHub still computes `mergeable`. */
function computingPull(snapshot: IssueSnapshot): PullRequestState | undefined {
  return snapshot.branches.current.pullRequests.find(
    (pull) => pull.state === "open" && pull.mergeable === null,
  );
}
