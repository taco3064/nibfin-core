import {
  type ActingClient,
  deliveryBranch,
  deriveStage,
  findMarkedComment,
  type IssueSnapshot,
  type MarkedComment,
  type PullRequestState,
  readIssueSnapshot,
  type RequiredCheckResult,
  type Stage,
  type WorkflowRunSummary,
} from "../github/index.ts";
import type { FixReason, JobContext } from "./context.ts";

/** The comment key of the Shape review on a pull request (#673). */
export const reviewCommentKey = "review";

/** What a fix run fixes, as GitHub shows it. */
export type FixPointer =
  | { reason: "ci-failure"; pullRequest: PullRequestState; failed: RequiredCheckResult[] }
  | { reason: "review"; pullRequest: PullRequestState; comment: MarkedComment }
  | {
      reason: "cd-failure";
      /** The newest merged PR whose CD failed, and its failed runs. */
      pullRequest: PullRequestState | undefined;
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
  | { eligible: false; description: string };

/** The derived stage as logged, with the reason of an ineligible one. */
export function describeStage(stage: Stage): string {
  return stage.stage === "ineligible" ? `ineligible (${stage.reason})` : stage.stage;
}

/** The head SHA a review comment records on its `Reviewed head: <sha>` line. */
export function reviewedHead(body: string): string | undefined {
  return /^Reviewed head: ([0-9a-f]{7,64})\s*$/m.exec(body)?.[1];
}

/** The newest merged pull request of the Issue whose CD failed, with the failed runs. */
function failedCd(snapshot: IssueSnapshot) {
  for (const pull of snapshot.pullRequests) {
    const failed = (pull.cd?.runs ?? []).filter((run) => run.state === "failed");
    if (failed.length > 0) {
      return { pullRequest: pull, failed };
    }
  }
  return { pullRequest: undefined, failed: [] };
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
  if (reason === "review" && stage.stage === "review") {
    const pull = stage.pullRequest;
    const target = { ...context.repo, number: pull.number };
    const comment = await findMarkedComment(client, target, reviewCommentKey);
    if (comment === undefined || reviewedHead(comment.body) !== pull.headSha) {
      return undefined;
    }
    return {
      branch: stage.branch,
      openPull: pull,
      fix: { reason, pullRequest: pull, comment },
    };
  }
  if (reason === "cd-failure") {
    const fix = { reason, ...failedCd(snapshot) };
    if (stage.stage === "cd-failed") {
      return { branch: stage.nextFixBranch, openPull: undefined, fix };
    }
    if (stage.stage === "deliver" && stage.branch !== deliveryBranch(context.issue)) {
      return { branch: stage.branch, openPull: undefined, fix };
    }
  }
  return undefined;
}

/**
 * Whether the Issue is at the Deliver stage for the Job's reason, and on which branch:
 * no reason → `deliver`; `ci-failure` → `ci-failed`; `review` → `review` with a
 * marked review comment whose recorded head is the current PR head; `cd-failure` →
 * `cd-failed` (on `nextFixBranch`), or `deliver` on a fix branch (a redo).
 */
export async function readEligibility(
  client: ActingClient,
  context: JobContext,
): Promise<Eligibility> {
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  const decision = await decide(client, context, snapshot, stage);
  if (decision === undefined) {
    const reason = context.reason ?? "no reason";
    return { eligible: false, description: `${describeStage(stage)} (${reason})` };
  }
  return { eligible: true, snapshot, ...decision };
}
