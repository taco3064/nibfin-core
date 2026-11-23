import { tmpdir } from "node:os";
import {
  type ActingClient,
  type IssueRef,
  type Repo,
  upsertMarkedComment,
} from "../github/index.ts";
import { defaultStageDeps, issueOf, type StageDeps } from "./agent.ts";
import type { JobContext } from "./context.ts";
import { reviewCommentKey } from "./deliver-eligibility.ts";

import { StageError } from "./errors.ts";
import { githubRemoteUrl, type GitRunner, runGitProcess } from "./git.ts";
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";

/** The comment key of the report a blocked review or merge leaves on the Issue. */
export const reviewBlockedCommentKey = "review-blocked";

/** The comment key of the closing comment on a delivered Issue. */
export const deliveredCommentKey = "delivered";

/** What the review stage calls out to, beyond the harness; tests replace each. */
export interface ReviewDeps extends StageDeps {
  runGit: GitRunner;
  remoteUrl: (repo: Repo) => string;
  /** Where Core creates its own fetch repository, outside the workspace. */
  coreRepoParent: string;
}

export const defaultReviewDeps: ReviewDeps = {
  ...defaultStageDeps,
  runGit: runGitProcess,
  remoteUrl: githubRemoteUrl,
  coreRepoParent: tmpdir(),
};

/** One review Job: its context, client and dependencies. */
export interface ReviewScope {
  readonly context: JobContext;
  readonly client: ActingClient;
  readonly deps: ReviewDeps;
}

export function issueName(scope: ReviewScope): string {
  const { repo, issue } = scope.context;
  return `${repo.owner}/${repo.repo}#${issue}`;
}

/** The pull request as an Issue reference, for its comments. */
export function pullTarget(scope: ReviewScope, number: number): IssueRef {
  return { ...scope.context.repo, number };
}

export const requestReviewFix: NextAction = { stage: "deliver", reason: "review" };

/**
 * Writes the marked `review` comment on the pull request, recording `head` on its
 * `Reviewed head:` line, and asks for a Deliver `review` fix.
 */
export async function sendBackToDeliver(
  scope: ReviewScope,
  pullNumber: number,
  head: string,
  text: string,
): Promise<NextAction> {
  const body = `Reviewed head: ${head}\n\n${text}`;
  const target = pullTarget(scope, pullNumber);
  const comment = await upsertMarkedComment(scope.client, target, reviewCommentKey, body);
  scope.deps.log(`Review comment: ${comment.url}; requesting a review fix`);
  return requestReviewFix;
}

/** Reports a blocked review or merge on the Issue and stops with `STAGE_BLOCKED`. */
export async function blockReview(
  scope: ReviewScope,
  title: string,
  reason: string,
): Promise<never> {
  const body = `The review is blocked (${title}).\n\n${reason}`;
  const issue = issueOf(scope.context);
  const key = reviewBlockedCommentKey;
  const comment = await upsertMarkedComment(scope.client, issue, key, body);
  await writeNextAction(scope.context, noNextAction);
  throw new StageError(
    "STAGE_BLOCKED",
    `${title} returned blocked (${comment.url}):\n${reason}`,
  );
}
