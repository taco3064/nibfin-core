import {
  type ActingClient,
  findMarkedComment,
  hasWritePermission,
  type IssueRef,
  type PullRequestSummary,
  readLatestReviews,
  readMergeRules,
  readRequestedReviewers,
  upsertMarkedComment,
} from "../github/index.ts";
import { reviewedHead, reviewedShape } from "./deliver-eligibility.ts";
import { pullTarget, type ReviewScope } from "./review-scope.ts";
import { readCurrentShape } from "./shape-wrong.ts";

/**
 * The comment key of the wait for required approvals on a pull request (#725). It
 * records the head and the Shape version whose Shape review passed.
 */
export const approvalWaitCommentKey = "approval-wait";

/** A writer's latest review that requested changes. */
export interface ChangeRequest {
  id: number;
  login: string;
  commitId: string | null;
  url: string;
  body: string;
}

/** What keeps a ruleset's approval requirement unmet, counting only writers. */
export interface MissingApprovals {
  /** The largest number of approving reviews a ruleset of the base requires. */
  required: number;
  /** Writers whose latest review approves. */
  approvals: number;
  /** Writers whose latest review requests changes, on any head, oldest first. */
  changeRequests: ChangeRequest[];
}

type Pull = Pick<PullRequestSummary, "number" | "baseRef" | "headSha">;

/**
 * The approvals a ruleset `pull_request` rule of the base still lacks, as GitHub
 * decides it: only reviewers with write access count, and a writer's request for
 * changes stands until that writer approves. `undefined` when no ruleset
 * `pull_request` rule applies, or the writers' approvals meet it and no writer's
 * request for changes is outstanding.
 */
export async function missingApprovals(
  client: ActingClient,
  issue: Pick<IssueRef, "owner" | "repo">,
  pull: Pull,
): Promise<MissingApprovals | undefined> {
  const repo = { owner: issue.owner, repo: issue.repo };
  const rules = await readMergeRules(client, repo, pull.baseRef);
  if (rules.pullRequest.length === 0) {
    return undefined;
  }
  const required = Math.max(...rules.pullRequest.map((rule) => rule.requiredApprovals));
  const reviews = await readLatestReviews(client, repo, pull.number);
  const counted = reviews.filter(
    (review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED",
  );
  const writers = [];
  for (const review of counted) {
    if (await hasWritePermission(client, repo, review.login)) {
      writers.push(review);
    }
  }
  const approvals = writers.filter((review) => review.state === "APPROVED").length;
  const changeRequests = writers
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .toSorted((a, b) => a.id - b.id)
    .map(({ id, login, commitId, url, body }) => ({ id, login, commitId, url, body }));
  if (approvals >= required && changeRequests.length === 0) {
    return undefined;
  }
  return { required, approvals, changeRequests };
}

function listOf(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

/**
 * Writes the marked `approval-wait` comment on the pull request: the passing Shape
 * review of `head` and `shapeVersion`, the requirement, the writers' approvals, the
 * writers whose requested changes still need their approval and the requested
 * reviewers. Logins are in backticks without `@`, so nobody is pinged again.
 */
export async function writeApprovalWait(
  scope: ReviewScope,
  pull: Pull,
  head: string,
  shapeVersion: string,
  missing: MissingApprovals,
): Promise<void> {
  const { client, context } = scope;
  const requested = await readRequestedReviewers(client, context.repo, pull.number);
  const lines = [
    `Reviewed head: ${head}`,
    `Reviewed Shape: ${shapeVersion}`,
    "",
    "The Shape review passed. The merge waits for approving reviews.",
    "",
    `A ruleset of \`${pull.baseRef}\` requires ${missing.required} approving ` +
      `review(s) from users with write access; the pull request has ` +
      `${missing.approvals}.`,
  ];
  if (missing.changeRequests.length > 0) {
    lines.push("", "Requested changes that need the reviewer's approval before merging:");
    for (const change of missing.changeRequests) {
      lines.push(`- \`${change.login}\`: ${change.url}`);
    }
  }
  const users = requested.users.length > 0 ? listOf(requested.users) : "none";
  const teams = requested.teams.length > 0 ? listOf(requested.teams) : "none";
  lines.push(
    "",
    `Requested reviewers: ${users}. Requested teams: ${teams}.`,
    "",
    "The Issue continues when a review is submitted.",
  );
  const target = pullTarget(scope, pull.number);
  const key = approvalWaitCommentKey;
  const comment = await upsertMarkedComment(
    client,
    target,
    key,
    lines.join("\n"),
    "pull-request",
  );
  scope.deps.log(`Waiting for approving reviews: ${comment.url}`);
}

/** A current wait for approvals, as GitHub shows it now. */
export type ApprovalWait =
  | { kind: "waiting"; shapeVersion: string }
  | { kind: "ready"; shapeVersion: string }
  | { kind: "changes-requested"; shapeVersion: string; review: ChangeRequest };

/**
 * The actor's `approval-wait` comment when it records the pull request's current
 * head and the current Shape version, read against GitHub now: a writer's request
 * for changes on that head → `changes-requested` (the newest one); approvals still
 * missing → `waiting`; else `ready`. `undefined` without a current comment.
 */
export async function readApprovalWait(
  client: ActingClient,
  issue: IssueRef,
  pull: Pull,
): Promise<ApprovalWait | undefined> {
  const target = { owner: issue.owner, repo: issue.repo, number: pull.number };
  const key = approvalWaitCommentKey;
  const comment = await findMarkedComment(client, target, key, "pull-request");
  if (comment === undefined || reviewedHead(comment.body) !== pull.headSha) {
    return undefined;
  }
  const shapeVersion = reviewedShape(comment.body);
  const shape = await readCurrentShape(client, issue);
  if (shapeVersion === undefined || shapeVersion !== shape?.version) {
    return undefined;
  }
  const missing = await missingApprovals(client, issue, pull);
  if (missing === undefined) {
    return { kind: "ready", shapeVersion };
  }
  const onHead = missing.changeRequests.filter(
    (change) => change.commitId === pull.headSha,
  );
  const review = onHead.at(-1);
  if (review !== undefined) {
    return { kind: "changes-requested", shapeVersion, review };
  }
  return { kind: "waiting", shapeVersion };
}
