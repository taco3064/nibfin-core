import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActingClient,
  type DeliveryOutcome,
  deriveStage,
  type IssueSnapshot,
  type PullRequestState,
  readIssueSnapshot,
  readPullRequest,
  readReviewComments,
} from "../github/index.ts";
import { issueOf, prepareStageJob, runStageAgent } from "./agent.ts";
import { closedAsDelivered, settleMerged } from "./closing.ts";
import { type FinishContext, isAgentContext, type JobContext } from "./context.ts";
import { currentReview, describeStage } from "./deliver-eligibility.ts";
import { readDeliverSources } from "./deliver-prompts.ts";
import { checkoutReviewedHead, Git } from "./git.ts";
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";
import { mergeReviewed } from "./review-merge.ts";
import {
  parseReviewerResult,
  type ReviewerResult,
  reviewerRole,
} from "./review-roles.ts";
import { trackProgress } from "./progress.ts";
import {
  blockReview,
  defaultReviewDeps,
  handBackToShape,
  issueName,
  requestReviewFix,
  type ReviewDeps,
  type ReviewScope,
  sendBackToDeliver,
} from "./review-scope.ts";
import { reviewSections } from "./review-sources.ts";
import { type ChangeRequest, readApprovalWait } from "./review-wait.ts";
import { readPendingReport } from "./shape-wrong.ts";
import { wakeDownstream } from "./wake.ts";

/** The CI outcomes carry the required checks and their results. */
type ReviewOutcome = Extract<DeliveryOutcome, { requiredChecks: unknown }>;

function listProblems(problems: readonly string[]): string {
  const items = problems.map((problem) => `- ${problem}`).join("\n");
  return `Problems found in the review:\n\n${items}`;
}

/**
 * The review feedback of a writer's request for changes on the head, as the marked
 * `review` comment gives it to Deliver: its author (backticks, no `@`), URL, text
 * and inline comments.
 */
async function describeChangeRequest(
  scope: ReviewScope,
  pull: PullRequestState,
  change: ChangeRequest,
): Promise<string> {
  const { client, context } = scope;
  const inline = await readReviewComments(client, context.repo, pull.number, change.id);
  const parts = [
    `\`${change.login}\` requested changes on this head in a pull request review: ` +
      change.url,
    change.body.trim() === "" ? "(The review has no text.)" : change.body.trim(),
  ];
  for (const comment of inline) {
    const { path, line } = comment;
    const where = line === null ? path : `${path}:${line}`;
    parts.push(`Inline comment on \`${where}\` (${comment.url}):\n\n${comment.body}`);
  }
  return parts.join("\n\n");
}

/**
 * Runs a fresh read-only reviewer on the pinned head, fetched through Core's own
 * repository and checked out detached; the reviewer never gets the token. Returns
 * the verdict with the version of the Shape text the reviewer was given.
 */
async function review(
  scope: ReviewScope,
  context: JobContext,
  snapshot: IssueSnapshot,
  stage: ReviewOutcome,
): Promise<{ verdict: ReviewerResult; shapeVersion: string }> {
  const { client, deps } = scope;
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
  const job = await prepareStageJob(context, client, deps, [reviewerRole.skill]);
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
    const message = await runStageAgent(job, reviewerRole, sections);
    const verdict = parseReviewerResult(message, head);
    return { verdict, shapeVersion: requirements.shapeVersion };
  } finally {
    await rm(coreRepo, { recursive: true, force: true });
  }
}

/**
 * At `review`: a pending report that the Shape is wrong stops it (no review, no
 * merge). Otherwise it pins the PR head, reuses a review already recorded for that
 * head and the current Shape version, or a passing one an `approval-wait` comment
 * records (a writer's request for changes on the head becomes the review fix; else
 * the merge is re-checked), else reviews it, re-reads GitHub and acts on
 * the verdict only for the same head. A finish Job never reviews: when the head
 * still needs the reviewer it asks for the review stage instead.
 */
async function reviewPullRequest(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
  stage: ReviewOutcome,
): Promise<NextAction> {
  const { client, context, deps } = scope;
  const pull = stage.pullRequest;
  const head = pull.headSha;
  const issue = issueOf(context);
  if (await readPendingReport(client, issue, deps.log)) {
    deps.log(`${issueName(scope)}: the Shape is reported wrong; not reviewing`);
    return handBackToShape;
  }
  // Reading the pull request starts GitHub's mergeability computation early, so the
  // merge after the review usually finds it done (#674).
  await readPullRequest(client, context.repo, pull.number);
  const existing = await currentReview(client, issue, pull);
  if (existing?.current === true) {
    const { url } = existing.comment;
    deps.log(`${url} already reviews ${head}; requesting the review fix`);
    return requestReviewFix;
  }
  if (existing !== undefined) {
    deps.log(`${existing.comment.url} was written for another Shape version`);
  }
  const wait = await readApprovalWait(client, issue, pull);
  if (wait?.kind === "changes-requested") {
    deps.log(`${wait.review.url} requests changes on ${head}; requesting a review fix`);
    const text = await describeChangeRequest(scope, pull, wait.review);
    return sendBackToDeliver(scope, pull.number, head, wait.shapeVersion, text);
  }
  if (wait !== undefined) {
    deps.log(`The Shape review of ${head} already passed; re-checking the merge`);
    return mergeReviewed(scope, pull, head, wait.shapeVersion);
  }
  if (!isAgentContext(context)) {
    deps.log(`${pull.url} at ${head} needs the reviewer; asking for the review stage`);
    return { stage: "review", reason: null };
  }
  const { verdict, shapeVersion } = await review(scope, context, snapshot, stage);
  const now = deriveStage(await readIssueSnapshot(client, context.repo, context.issue));
  const same =
    now.stage === "review" &&
    now.pullRequest.number === pull.number &&
    now.pullRequest.headSha === head;
  if (!same) {
    scope.progress.mark();
    deps.log(
      `The Issue moved on during the review (now ${describeStage(now)}); ` +
        "stopping without writing",
    );
    return noNextAction;
  }
  if (verdict.outcome === "problems") {
    const text = listProblems(verdict.problems);
    return sendBackToDeliver(scope, pull.number, head, shapeVersion, text);
  }
  if (verdict.outcome === "blocked") {
    return blockReview(scope, reviewerRole.title, verdict.reason);
  }
  return mergeReviewed(scope, pull, head, shapeVersion);
}

async function dispatch(scope: ReviewScope): Promise<NextAction> {
  const { client, context, deps } = scope;
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  switch (stage.stage) {
    case "review":
      return reviewPullRequest(scope, snapshot, stage);
    case "awaiting-cd":
    case "cd-failed":
    case "done":
      return settleMerged(scope, snapshot, stage);
    case "conflict":
      deps.log(`${issueName(scope)}: the PR conflicts with its base; requesting a fix`);
      return { stage: "deliver", reason: "conflict" };
  }
  const closed = stage.stage === "ineligible" && stage.reason === "closed";
  if (closed && (await closedAsDelivered(client, issueOf(context), snapshot))) {
    deps.log(`${issueName(scope)} is already closed as delivered; waking downstream`);
    return { ...noNextAction, wake: await wakeDownstream(scope) };
  }
  deps.log(`${issueName(scope)} is not at the review stage: ${describeStage(stage)}`);
  return noNextAction;
}

/**
 * The review stage, by the derived stage: `review` reviews the PR head and sends
 * problems back to Deliver or merges a clean PR; `cd-failed` asks for a CD-failure
 * fix; `conflict` asks for a conflict fix; `done` writes the closing comment, closes
 * the Issue as delivered and names the downstream Issues to wake. Returns the exit
 * code; writes the next action.
 */
export async function runReviewStage(
  context: JobContext,
  client: ActingClient,
  deps: ReviewDeps = defaultReviewDeps,
): Promise<number> {
  return runStage(context, client, deps);
}

/**
 * The finish stage: the review stage's steps that run no agent, with a context that
 * has no agent fields (#755). It merges a head whose Shape review an `approval-wait`
 * comment records, turns a writer's request for changes into the review fix, closes
 * a `done` Issue and wakes its downstream Issues; a head that still needs the
 * reviewer asks for the review stage. Returns the exit code; writes the next action.
 */
export async function runFinishStage(
  context: FinishContext,
  client: ActingClient,
  deps: ReviewDeps = defaultReviewDeps,
): Promise<number> {
  return runStage(context, client, deps);
}

async function runStage(
  context: JobContext | FinishContext,
  client: ActingClient,
  deps: ReviewDeps,
): Promise<number> {
  const progress = trackProgress(client);
  const scope: ReviewScope = { context, client: progress.client, deps, progress };
  let next: NextAction;
  try {
    next = await dispatch(scope);
  } catch (error) {
    await writeNextAction(context, noNextAction, progress.progressed);
    throw error;
  }
  await writeNextAction(context, next, progress.progressed);
  return 0;
}
