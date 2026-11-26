import {
  allowedMergeMethods,
  deriveStage,
  freshReads,
  GitHubError,
  mergePullRequest,
  type MergeResult,
  type PullRequestState,
  readApprovalCount,
  readIssueSnapshot,
  readMergeRules,
  readMergeSettings,
  readPullRequest,
  responseMessage,
} from "../github/index.ts";
import { issueOf } from "./agent.ts";
import { describeStage } from "./deliver-eligibility.ts";
import { type NextAction, noNextAction } from "./next.ts";
import {
  blockReview,
  handBackToShape,
  type ReviewScope,
  sendBackToDeliver,
} from "./review-scope.ts";
import { missingApprovals, writeApprovalWait } from "./review-wait.ts";
import { readPendingReport } from "./shape-wrong.ts";

const mergeTitle = "Merge";

/** GitHub's wording when a change to `.github/workflows/` needs that permission. */
function isWorkflowsRejection(message: string): boolean {
  return /\bworkflows?\b/i.test(message) && /\b(permission|scope)\b/i.test(message);
}

const workflowsReason = (message: string) =>
  "GitHub rejected the merge: the pull request changes `.github/workflows/` and " +
  `Nibfin's token lacks the workflows permission.\n\n${message}`;

const rebaseText = (base: string, message: string) =>
  `Rebase onto \`${base}\` and resolve conflicts: ${message}`;

const outOfDateReason = (pull: PullRequestState, head: string, message: string) =>
  `GitHub did not merge ${pull.url} at ${head} because the head is behind ` +
  `\`${pull.baseRef}\` and the repository requires branches to be up to date ` +
  `before merging: ${message}\n\nThe pull request has no conflict, so Nibfin does ` +
  'not send it back to Deliver. Turn off "Require branches to be up to date before ' +
  'merging", or update the branch yourself, then remove `pending`.';

const computingReason = (pull: PullRequestState, head: string, message: string) =>
  `GitHub did not merge ${pull.url} at ${head}: ${message}\n\nGitHub was still ` +
  "computing whether the pull request conflicts with the base. Remove `pending` " +
  "to check again.";

/**
 * The ruleset requirements that can keep a pull request `blocked`, with the current
 * approvals. Classic branch protection needs Administration to read, so when no
 * readable rule explains it the message says so.
 */
export async function describeBlocked(scope: ReviewScope, pull: PullRequestState) {
  const { client, context } = scope;
  const rules = await readMergeRules(client, context.repo, pull.baseRef);
  const approvals = await readApprovalCount(client, context.repo, pull.number);
  const lines: string[] = [];
  for (const rule of rules.pullRequest) {
    if (rule.requiredApprovals > approvals) {
      lines.push(
        `A ruleset requires ${rule.requiredApprovals} approving review(s); ` +
          `the pull request has ${approvals}.`,
      );
    }
    if (rule.codeOwnerReview) {
      lines.push("A ruleset requires a review from a code owner.");
    }
    if (rule.lastPushApproval) {
      lines.push("A ruleset requires approval of the most recent push.");
    }
    if (rule.threadResolution) {
      lines.push("A ruleset requires every review thread to be resolved.");
    }
  }
  const intro =
    `GitHub reports pull request ${pull.url} as blocked (\`mergeable_state: ` +
    `blocked\`) at ${pull.headSha}.`;
  if (lines.length === 0) {
    return (
      `${intro} No ruleset requirement Nibfin can read explains it; classic branch ` +
      "protection (such as required approvals) is not readable without " +
      "Administration. Check the pull request's merge box."
    );
  }
  const list = lines.map((line) => `- ${line}`).join("\n");
  return `${intro} Requirements that may be unmet:\n\n${list}`;
}

/** The first method the repository settings and the base's rulesets both allow. */
async function chooseMethod(scope: ReviewScope, base: string) {
  const { client, context } = scope;
  const settings = await readMergeSettings(client, context.repo);
  const rules = await readMergeRules(client, context.repo, base);
  const methods = allowedMergeMethods(settings, rules);
  if (methods === undefined) {
    return blockReview(
      scope,
      mergeTitle,
      "The repository's merge settings are not readable with Nibfin's token, so no " +
        "merge method can be chosen.",
    );
  }
  const method = methods.at(0);
  if (method === undefined) {
    return blockReview(
      scope,
      mergeTitle,
      "No merge method is allowed by both the repository settings and the rulesets " +
        `of \`${base}\`.`,
    );
  }
  return method;
}

async function merge(
  scope: ReviewScope,
  pull: PullRequestState,
  head: string,
): Promise<MergeResult> {
  const method = await chooseMethod(scope, pull.baseRef);
  const request = { number: pull.number, sha: head, method };
  try {
    const result = await mergePullRequest(scope.client, scope.context.repo, request);
    if (result.outcome === "merged") {
      const commit = result.mergeCommitSha ?? "(unknown)";
      scope.deps.log(`Merged ${pull.url} at ${head} (${method}) as ${commit}`);
    }
    return result;
  } catch (error) {
    const message =
      error instanceof GitHubError && error.code === "GITHUB_WRITE_REJECTED"
        ? responseMessage(error.cause)
        : undefined;
    if (message !== undefined && isWorkflowsRejection(message)) {
      return blockReview(scope, mergeTitle, workflowsReason(message));
    }
    throw error;
  }
}

/**
 * Merges a pull request the reviewer found clean at `head`, under the repository's
 * own rules: re-checks the stage (`pause` included) and the head, reads GitHub's
 * mergeability, sends only conflicting work back to Deliver (a head that is merely
 * behind the base is merged as it is; GitHub's merge applies it), waits (marked
 * `approval-wait` comment, next action none) when a ruleset still lacks writers'
 * approvals or a writer's requested changes stand, stops on other unmet rules, and
 * merges only at `head` with an allowed method. A pending report
 * that the Shape is wrong stops it and asks Deliver to hand the Issue back to Shape.
 * Merging is not completion: CD events follow, so the next action is none.
 * `shapeVersion` is the version of the Shape the review read; rebase requests
 * record it.
 */
export async function mergeReviewed(
  scope: ReviewScope,
  pull: PullRequestState,
  head: string,
  shapeVersion: string,
): Promise<NextAction> {
  const { client, context, deps } = scope;
  // The merge cannot be undone: its re-check always reads GitHub's current state.
  freshReads(client);
  const stage = deriveStage(await readIssueSnapshot(client, context.repo, context.issue));
  const samePull =
    stage.stage === "review" &&
    stage.pullRequest.number === pull.number &&
    stage.pullRequest.headSha === head;
  if (!samePull) {
    scope.progress.mark();
    deps.log(`Not merging: the Issue is now ${describeStage(stage)}`);
    return noNextAction;
  }
  if (await readPendingReport(client, issueOf(context), deps.log)) {
    deps.log("Not merging: the Shape is reported wrong; asking Deliver to return it");
    return handBackToShape;
  }
  const rebase = (message: string) =>
    sendBackToDeliver(
      scope,
      pull.number,
      head,
      shapeVersion,
      rebaseText(pull.baseRef, message),
    );
  const detail = await readPullRequest(client, context.repo, pull.number);
  if (detail.headSha !== head || detail.state !== "open") {
    scope.progress.mark();
    deps.log(`Not merging: ${pull.url} is no longer open at ${head}`);
    return noNextAction;
  }
  const state = detail.mergeableState;
  if (detail.mergeable === null || state === "unknown") {
    deps.log(`Not merging: GitHub is still computing the mergeability of ${pull.url}`);
    return noNextAction;
  }
  if (state === "dirty") {
    return rebase("GitHub reports `mergeable_state: dirty`.");
  }
  if (state === "blocked") {
    const missing = await missingApprovals(client, context.repo, pull);
    if (missing !== undefined) {
      await writeApprovalWait(scope, pull, head, shapeVersion, missing);
      return noNextAction;
    }
    return blockReview(scope, mergeTitle, await describeBlocked(scope, pull));
  }
  const attemptMerge = async (baseSha: string): Promise<NextAction> => {
    const result = await merge(scope, pull, head);
    if (result.outcome === "head-changed") {
      scope.progress.mark();
      deps.log(`Not merged: the head of ${pull.url} is no longer ${head}`);
      return noNextAction;
    }
    if (result.outcome !== "not-mergeable") {
      return noNextAction;
    }
    const next = await notMergeable(scope, pull, head, result.message, rebase, baseSha);
    if (!("retryOnBase" in next)) {
      return next;
    }
    deps.log(
      `Merging ${pull.url} again: \`${pull.baseRef}\` moved to ${next.retryOnBase} ` +
        `and GitHub refused it without a conflict (${result.message})`,
    );
    return attemptMerge(next.retryOnBase);
  };
  return attemptMerge(detail.baseSha);
}

/** `notMergeable`'s answer that the same head can be merged again on a moved base. */
interface RetryMerge {
  retryOnBase: string;
}

/** States in which GitHub would merge the pull request now. */
const mergeableStates = new Set(["clean", "unstable", "has_hooks"]);

/**
 * A 405 from the merge. GitHub's message does not reliably say why, so the pull
 * request is read again: a head that moved or a pull request no longer open stops
 * with no next action, GitHub's own conflict signal (`mergeable: false` or `dirty`)
 * sends it back to Deliver, `behind` means an up-to-date requirement stopped a merge
 * that has no conflict, and a pull request GitHub reports mergeable or is still
 * computing is merged again when the base moved since `baseSha` (the base the
 * refused merge saw): each attempt needs a new base, so there is no count to pick.
 * Otherwise it is `review-blocked` naming the state and GitHub's message.
 */
async function notMergeable(
  scope: ReviewScope,
  pull: PullRequestState,
  head: string,
  message: string,
  rebase: (message: string) => Promise<NextAction>,
  baseSha: string,
): Promise<NextAction | RetryMerge> {
  if (isWorkflowsRejection(message)) {
    return blockReview(scope, mergeTitle, workflowsReason(message));
  }
  if (/head branch was modified/i.test(message)) {
    scope.progress.mark();
    scope.deps.log(`Not merged: the head of ${pull.url} moved (${message})`);
    return noNextAction;
  }
  const after = await readPullRequest(scope.client, scope.context.repo, pull.number);
  if (after.headSha !== head || after.state !== "open") {
    scope.progress.mark();
    scope.deps.log(`Not merged: ${pull.url} is no longer open at ${head}`);
    return noNextAction;
  }
  if (after.mergeable === false || after.mergeableState === "dirty") {
    return rebase(message);
  }
  if (after.mergeableState === "behind") {
    return blockReview(scope, mergeTitle, outOfDateReason(pull, head, message));
  }
  const computing = after.mergeable === null || after.mergeableState === "unknown";
  const baseMoved = after.baseSha !== baseSha;
  if (baseMoved && (computing || mergeableStates.has(after.mergeableState))) {
    return { retryOnBase: after.baseSha };
  }
  if (computing) {
    return blockReview(scope, mergeTitle, computingReason(pull, head, message));
  }
  return blockReview(
    scope,
    mergeTitle,
    `GitHub did not merge ${pull.url} at ${head}: ${message}`,
  );
}
