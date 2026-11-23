import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActingClient,
  type DeliveryOutcome,
  deriveStage,
  findMarkedComment,
  type IssueSnapshot,
  nibfinLabels,
  readIssueSnapshot,
} from "../github/index.ts";
import { issueOf, prepareStageJob, runStageAgent } from "./agent.ts";
import { closeIssue } from "./closing.ts";
import type { JobContext } from "./context.ts";
import { describeStage, reviewCommentKey, reviewedHead } from "./deliver-eligibility.ts";
import { readDeliverSources } from "./deliver-prompts.ts";
import { checkoutReviewedHead, Git } from "./git.ts";
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";
import { mergeReviewed } from "./review-merge.ts";
import {
  parseReviewerResult,
  type ReviewerResult,
  reviewerRole,
} from "./review-roles.ts";
import {
  blockReview,
  defaultReviewDeps,
  deliveredCommentKey,
  issueName,
  pullTarget,
  requestReviewFix,
  type ReviewDeps,
  type ReviewScope,
  sendBackToDeliver,
} from "./review-scope.ts";
import { reviewSections } from "./review-sources.ts";
import { wakeDownstream } from "./wake.ts";

/** The CI outcomes carry the required checks and their results. */
type ReviewOutcome = Extract<DeliveryOutcome, { requiredChecks: unknown }>;

function listProblems(problems: readonly string[]): string {
  const items = problems.map((problem) => `- ${problem}`).join("\n");
  return `Problems found in the review:\n\n${items}`;
}

/**
 * Runs a fresh read-only reviewer on the pinned head, fetched through Core's own
 * repository and checked out detached; the reviewer never gets the token.
 */
async function review(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
  stage: ReviewOutcome,
): Promise<ReviewerResult> {
  const { client, context, deps } = scope;
  const pull = stage.pullRequest;
  const head = pull.headSha;
  const requirements = await readDeliverSources(
    client,
    issueOf(context),
    snapshot.issue.url,
  );
  if (requirements === undefined) {
    return blockReview(scope, "Review stage", "The Issue has no approved Shape comment.");
  }
  const job = await prepareStageJob(context, client, deps);
  const coreRepo = await mkdtemp(join(deps.coreRepoParent, "nibfin-review-"));
  try {
    const git = new Git({
      workspace: context.workspace,
      coreRepo,
      remoteUrl: deps.remoteUrl(context.repo),
      token: context.token,
      run: deps.runGit,
    });
    const diff = await checkoutReviewedHead(git, { base: pull.baseRef, head });
    const sections = reviewSections({
      requirements,
      pullRequest: pull,
      head,
      base: pull.baseRef,
      diff,
      results: stage.results,
    });
    deps.log(`Reviewing ${pull.url} at ${head}`);
    return parseReviewerResult(await runStageAgent(job, reviewerRole, sections), head);
  } finally {
    await rm(coreRepo, { recursive: true, force: true });
  }
}

/**
 * At `review`: pins the PR head, reuses a review already recorded for it, otherwise
 * reviews it, re-reads GitHub and acts on the verdict only for the same head.
 */
async function reviewPullRequest(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
  stage: ReviewOutcome,
): Promise<NextAction> {
  const { client, context, deps } = scope;
  const pull = stage.pullRequest;
  const head = pull.headSha;
  const target = pullTarget(scope, pull.number);
  const existing = await findMarkedComment(client, target, reviewCommentKey);
  if (existing !== undefined && reviewedHead(existing.body) === head) {
    deps.log(`${existing.url} already reviews ${head}; requesting the review fix`);
    return requestReviewFix;
  }
  const verdict = await review(scope, snapshot, stage);
  const now = deriveStage(await readIssueSnapshot(client, context.repo, context.issue));
  const same =
    now.stage === "review" &&
    now.pullRequest.number === pull.number &&
    now.pullRequest.headSha === head;
  if (!same) {
    deps.log(
      `The Issue moved on during the review (now ${describeStage(now)}); ` +
        "stopping without writing",
    );
    return noNextAction;
  }
  if (verdict.outcome === "problems") {
    return sendBackToDeliver(scope, pull.number, head, listProblems(verdict.problems));
  }
  if (verdict.outcome === "blocked") {
    return blockReview(scope, reviewerRole.title, verdict.reason);
  }
  return mergeReviewed(scope, pull, head);
}

/** A closed Issue that this stage already closed as delivered: only wake remains. */
async function closedAsDelivered(scope: ReviewScope, snapshot: IssueSnapshot) {
  if (!snapshot.issue.labels.includes(nibfinLabels.delivered)) {
    return false;
  }
  const issue = issueOf(scope.context);
  return (
    (await findMarkedComment(scope.client, issue, deliveredCommentKey)) !== undefined
  );
}

async function dispatch(scope: ReviewScope): Promise<NextAction> {
  const { client, context, deps } = scope;
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  switch (stage.stage) {
    case "review":
      return reviewPullRequest(scope, snapshot, stage);
    case "awaiting-cd":
      deps.log(`${issueName(scope)} is waiting for CD (${stage.reason})`);
      return noNextAction;
    case "cd-failed":
      deps.log(`${issueName(scope)}: CD failed; requesting a CD-failure fix`);
      return { stage: "deliver", reason: "cd-failure" };
    case "done":
      return closeIssue(scope, snapshot);
  }
  const closed = stage.stage === "ineligible" && stage.reason === "closed";
  if (closed && (await closedAsDelivered(scope, snapshot))) {
    deps.log(`${issueName(scope)} is already closed as delivered; waking downstream`);
    return { ...noNextAction, wake: await wakeDownstream(scope) };
  }
  deps.log(`${issueName(scope)} is not at the review stage: ${describeStage(stage)}`);
  return noNextAction;
}

/**
 * The review stage, by the derived stage: `review` reviews the PR head and sends
 * problems back to Deliver or merges a clean PR; `cd-failed` asks for a CD-failure
 * fix; `done` writes the closing comment, closes the Issue as delivered and names
 * the downstream Issues to wake. Returns the exit code; writes the next action.
 */
export async function runReviewStage(
  context: JobContext,
  client: ActingClient,
  deps: ReviewDeps = defaultReviewDeps,
): Promise<number> {
  const scope: ReviewScope = { context, client, deps };
  let next: NextAction;
  try {
    next = await dispatch(scope);
  } catch (error) {
    await writeNextAction(context, noNextAction);
    throw error;
  }
  await writeNextAction(context, next);
  return 0;
}
