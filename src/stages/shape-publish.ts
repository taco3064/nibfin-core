import {
  type ActingClient,
  commentMarker,
  deriveStage,
  findMarkedComment,
  type IssueRef,
  nibfinLabels,
  readIssueSnapshot,
  setLabels,
  type Stage,
  upsertMarkedComment,
} from "../github/index.ts";
import { type NextAction, noNextAction } from "./next.ts";
import { shapeCommentKey } from "./shape-sources.ts";
import {
  isDeliveryStage,
  readCurrentShape,
  readShapeWrong,
  resolveShapeWrong,
  shapeNextAction,
  unconfirmed,
} from "./shape-wrong.ts";

/** The comment key of the report a blocked Shape leaves on the Issue. */
export const shapeBlockedCommentKey = "shape-blocked";

const blockedResolvedBody = "Resolved: the Shape was approved and published.";

interface PublishScope {
  client: ActingClient;
  issue: IssueRef;
  log: (line: string) => void;
}

/**
 * Writes the Shape comment and confirms it by one read of its text and version: when
 * the write changed the body, the version must have changed too. Returns the
 * versions before and after the write.
 */
async function writeShape(scope: PublishScope, shape: string) {
  const { client, issue } = scope;
  const before = await readCurrentShape(client, issue);
  const desired = `${commentMarker(shapeCommentKey)}\n${shape}`;
  const comment = await upsertMarkedComment(client, issue, shapeCommentKey, shape);
  const after = await readCurrentShape(client, issue);
  if (after?.body !== desired) {
    throw unconfirmed("publish the Shape", "The read-back comment differs");
  }
  const changed = before !== undefined && before.body !== desired;
  if (changed && before.version === after.version) {
    throw unconfirmed("publish the Shape", "The Shape version did not change");
  }
  return { url: comment.url, before: before?.version, after: after.version };
}

/**
 * Publishes the approved Shape in this order, each step confirmed by reading it
 * back: the `shape` comment; an active `shape-wrong` report (re)written as resolved
 * by the new version, before `shaped`, so a rewrite with unchanged text never leaves
 * a pending report next to `shaped`; `shaped`; an earlier `shape-blocked` report
 * resolved. After a rewrite (this run resolved a report) the next action restarts
 * delivery from the stage derived now; otherwise there is none.
 */
export async function publishShape(
  scope: PublishScope,
  shape: string,
): Promise<NextAction> {
  const { client, issue, log } = scope;
  const versions = await writeShape(scope, shape);
  const report = await readShapeWrong(client, issue, versions.before, log);
  const rewrite = report?.active === true;
  if (rewrite) {
    await resolveShapeWrong(client, issue, report, versions.after);
    log(`Resolved ${report.comment.url} as Shape version ${versions.after}`);
  }
  const labels = await setLabels(client, issue, { add: [nibfinLabels.shaped] });
  if (!labels.includes(nibfinLabels.shaped)) {
    throw unconfirmed("add shaped", "The read-back labels lack shaped");
  }
  if (await findMarkedComment(client, issue, shapeBlockedCommentKey)) {
    await upsertMarkedComment(client, issue, shapeBlockedCommentKey, blockedResolvedBody);
  }
  log(`Published the Shape: ${versions.url} (version ${versions.after})`);
  if (!rewrite) {
    return noNextAction;
  }
  const snapshot = await readIssueSnapshot(client, issue, issue.number);
  return restartDelivery(scope, deriveStage(snapshot));
}

function restartDelivery(scope: PublishScope, stage: Stage): NextAction {
  const next = shapeNextAction(stage, scope.issue.number);
  const what = JSON.stringify(next);
  scope.log(`After the rewrite the Issue is at ${stage.stage}; next action: ${what}`);
  return next;
}

/**
 * A Shape run while the Issue is at a delivery stage. A report resolved by the
 * current Shape version is a redo after a crash before the next action: the
 * delivery restarts from the derived stage. A pending report (Deliver stopped before
 * removing `shaped`) asks for Deliver, whose start removes `shaped`; never a review
 * or fix under a Shape just reported wrong. Anything else: no next action.
 */
export async function notAtShape(scope: PublishScope, stage: Stage): Promise<NextAction> {
  if (!isDeliveryStage(stage)) {
    return noNextAction;
  }
  const { client, issue, log } = scope;
  const current = await readCurrentShape(client, issue);
  const report = await readShapeWrong(client, issue, current?.version, log);
  if (report?.pending === true) {
    log(`${report.comment.url} reports the current Shape wrong; asking for Deliver`);
    return { stage: "deliver", reason: null };
  }
  if (report?.active === true && !report.unresolved) {
    return restartDelivery(scope, stage);
  }
  return noNextAction;
}
