import type { ActingClient, IssueRef } from "../github/index.ts";
import type { JobContext } from "./context.ts";
import { currentReview, type Eligibility } from "./deliver-eligibility.ts";
import { type NextAction, noNextAction } from "./next.ts";
import {
  isDeliveryStage,
  readCurrentShape,
  readPendingReport,
  readShapeWrong,
  removeShaped,
  reportShapeWrong,
} from "./shape-wrong.ts";

/** What the Deliver stage reads and logs with while handling a Shape report (#686). */
export interface ShapeReportScope {
  client: ActingClient;
  context: JobContext;
  log: (line: string) => void;
}

export const askForShape: NextAction = { stage: "shape", reason: null };

function issueOf(context: JobContext): IssueRef {
  return { ...context.repo, number: context.issue };
}

/**
 * A redo after a crash between writing the `shape-wrong` report and removing
 * `shaped`: at any delivery stage (whatever the Job's reason) with a pending report,
 * no Writer runs; `shaped` is removed and confirmed, and the Shape stage is next.
 * `undefined` when there is no such report. A paused, closed or unscoped Issue
 * derives no delivery stage, so it is never touched here.
 */
export async function finishShapeReport(
  scope: ShapeReportScope,
  eligibility: Eligibility,
): Promise<NextAction | undefined> {
  if (!eligibility.eligible && !isDeliveryStage(eligibility.stage)) {
    return undefined;
  }
  const { client, context, log } = scope;
  const issue = issueOf(context);
  const report = await readPendingReport(client, issue, log);
  if (report === undefined) {
    return undefined;
  }
  log(`${report.comment.url} reports the current Shape wrong; removing shaped`);
  await removeShaped(client, issue);
  return askForShape;
}

/**
 * Writes the Writer's report that the Shape it was given (version `version`) is
 * wrong, then removes `shaped` and confirms it; the Shape stage is next.
 */
export async function reportWrongShape(
  scope: ShapeReportScope,
  version: string,
  reason: string,
): Promise<NextAction> {
  const issue = issueOf(scope.context);
  const comment = await reportShapeWrong(scope.client, issue, version, reason);
  scope.log(`The Writer reports the Shape wrong: ${comment.url}`);
  await removeShaped(scope.client, issue);
  return askForShape;
}

/**
 * The next action when Deliver ends ineligible. At the start, an Issue back at the
 * Shape stage with an unresolved report asks for the Shape stage (a redo after a
 * crash before the next action was written). At start and at every in-run re-check,
 * a `review` Issue whose review comment records the current head but not the
 * current Shape version asks for a new review, since no CI event follows. Otherwise
 * nothing.
 */
export async function ineligibleNextAction(
  scope: ShapeReportScope,
  eligibility: Eligibility,
  atStart: boolean,
): Promise<NextAction> {
  if (eligibility.eligible) {
    return noNextAction;
  }
  const { client, context, log } = scope;
  const issue = issueOf(context);
  const { stage } = eligibility;
  if (atStart && stage.stage === "shape") {
    const shape = await readCurrentShape(client, issue);
    const report = await readShapeWrong(client, issue, shape?.version, log);
    return report?.unresolved === true ? askForShape : noNextAction;
  }
  if (stage.stage === "review") {
    const review = await currentReview(client, issue, stage.pullRequest);
    if (review !== undefined && !review.current) {
      log(`${review.comment.url} was written for another Shape version; review again`);
      return { stage: "review", reason: null };
    }
  }
  return noNextAction;
}
