import {
  type ActingClient,
  commentMarker,
  deliveryBranch,
  findMarkedComment,
  GitHubError,
  type IssueRef,
  type MarkedComment,
  nibfinLabels,
  readMarkedComment,
  setLabels,
  type Stage,
  upsertMarkedComment,
} from "../github/index.ts";
import { type NextAction, noNextAction } from "./next.ts";
import { shapeCommentKey, shapeOfComment } from "./shape-sources.ts";

/** The comment key of the report that the approved Shape is wrong (#686). */
export const shapeWrongCommentKey = "shape-wrong";

const reportTitle = "The approved Shape is wrong (Writer).";
const resolvedTitle = "Resolved: a rewritten Shape was approved and written.";
const versionLine = /^Shape version: (\d+\.\d+)$/;
const rewrittenLine = /^Rewritten as Shape version: (\d+\.\d+)$/;

/** The approved Shape as one read: its text and its version. */
export interface CurrentShape {
  /** The whole comment body, marker included. */
  body: string;
  /** The Shape text without the marker. */
  text: string;
  /**
   * `<comment id>.<versions>`: it changes exactly when the Shape body is rewritten
   * (or the comment is recreated), never on reactions or unchanged upserts.
   */
  version: string;
}

/**
 * The actor's marked `shape` comment with its text and version, both from the one
 * GraphQL Issue-record read of the comment; `undefined` when there is none.
 */
export async function readCurrentShape(
  client: ActingClient,
  issue: IssueRef,
): Promise<CurrentShape | undefined> {
  const comment = await readMarkedComment(client, issue, shapeCommentKey);
  if (comment === undefined) {
    return undefined;
  }
  return {
    body: comment.body,
    text: shapeOfComment(comment.body),
    version: `${comment.id}.${comment.versions}`,
  };
}

/** The `shape-wrong` body for the Shape version the Writer was given. */
export function shapeWrongBody(version: string, reason: string): string {
  return `${reportTitle}\nShape version: ${version}\n\n${reason}`;
}

/** A `shape-wrong` report as read against the current Shape version. */
export interface ShapeWrongReport {
  comment: MarkedComment;
  /** The report as the Writer's run wrote it, without any resolution header. */
  original: string;
  reason: string;
  /** Not (yet) marked resolved. */
  unresolved: boolean;
  /** Unresolved and written for the current Shape version. */
  pending: boolean;
  /**
   * Unresolved, or resolved by a rewrite whose version is the current one (whose
   * publication may not have finished).
   */
  active: boolean;
  /** The version of the rewrite that resolved it, if resolved. */
  rewrittenAs: string | undefined;
}

/** The text after the first blank line, and the lines before it. */
function splitHeader(text: string): { header: string[]; rest: string } {
  const at = text.indexOf("\n\n");
  return at === -1
    ? { header: text.split("\n"), rest: "" }
    : { header: text.slice(0, at).split("\n"), rest: text.slice(at + 2) };
}

/**
 * Reads a `shape-wrong` comment body against `current`, the current Shape version.
 * A missing or malformed version line, or no current Shape, makes it neither pending
 * nor active; `problem` then says why.
 */
export function parseShapeWrong(
  comment: MarkedComment,
  current: string | undefined,
): { report: ShapeWrongReport; problem: string | undefined } {
  const content = comment.body.slice(commentMarker(shapeWrongCommentKey).length + 1);
  const unresolved = !content.startsWith("Resolved:");
  const outer = splitHeader(content);
  const original = unresolved ? content : outer.rest;
  const rewrittenAs = unresolved
    ? undefined
    : rewrittenLine.exec(outer.header[1] ?? "")?.[1];
  const inner = splitHeader(original);
  const reported = versionLine.exec(inner.header[1] ?? "")?.[1];
  const problem =
    reported === undefined
      ? "has no valid Shape version line"
      : current === undefined
        ? "has no current Shape to compare with"
        : undefined;
  const valid = problem === undefined;
  const report: ShapeWrongReport = {
    comment,
    original,
    reason: inner.rest,
    unresolved,
    pending: valid && unresolved && reported === current,
    active: valid && (unresolved || rewrittenAs === current),
    rewrittenAs,
  };
  return { report, problem };
}

/** The actor's `shape-wrong` report on the Issue, if any, read against `current`. */
export async function readShapeWrong(
  client: ActingClient,
  issue: IssueRef,
  current: string | undefined,
  log: (line: string) => void,
): Promise<ShapeWrongReport | undefined> {
  const comment = await findMarkedComment(client, issue, shapeWrongCommentKey);
  if (comment === undefined) {
    return undefined;
  }
  const { report, problem } = parseShapeWrong(comment, current);
  if (problem !== undefined) {
    log(`The shape-wrong report ${comment.url} ${problem}; ignoring it`);
  }
  return report;
}

/** The report when it is pending: unresolved and for the current Shape version. */
export async function readPendingReport(
  client: ActingClient,
  issue: IssueRef,
  log: (line: string) => void,
): Promise<ShapeWrongReport | undefined> {
  const shape = await readCurrentShape(client, issue);
  const report = await readShapeWrong(client, issue, shape?.version, log);
  return report?.pending === true ? report : undefined;
}

export function unconfirmed(operation: string, reason: string): GitHubError {
  return new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error(reason));
}

/** Writes the report for Shape version `version`; one marked comment per Issue. */
export async function reportShapeWrong(
  client: ActingClient,
  issue: IssueRef,
  version: string,
  reason: string,
): Promise<MarkedComment> {
  const body = shapeWrongBody(version, reason);
  return upsertMarkedComment(client, issue, shapeWrongCommentKey, body);
}

/** (Re)writes an active report as resolved by the rewrite `version`; read back. */
export async function resolveShapeWrong(
  client: ActingClient,
  issue: IssueRef,
  report: ShapeWrongReport,
  version: string,
): Promise<void> {
  const header = `${resolvedTitle}\nRewritten as Shape version: ${version}`;
  const body = `${header}\n\n${report.original}`;
  const key = shapeWrongCommentKey;
  const comment = await upsertMarkedComment(client, issue, key, body);
  if (comment.body !== `${commentMarker(key)}\n${body}`) {
    throw unconfirmed("resolve the shape-wrong report", "The read-back comment differs");
  }
}

/** Removes `shaped` and confirms it by the read-back labels. */
export async function removeShaped(client: ActingClient, issue: IssueRef) {
  const labels = await setLabels(client, issue, { remove: [nibfinLabels.shaped] });
  if (labels.includes(nibfinLabels.shaped)) {
    throw unconfirmed("remove shaped", "The read-back labels still have shaped");
  }
}

/** A stage of a shaped Issue: the delivery outcome of its branches, PRs, CI and CD. */
export function isDeliveryStage(stage: Stage): boolean {
  return stage.stage !== "ineligible" && stage.stage !== "shape";
}

/**
 * What runs next after a rewritten Shape, from the stage derived after `shaped` is
 * back: Deliver on the delivery branch, a CD-failure fix on a fix branch, a CI fix,
 * a conflict fix, a review (also of a `done` Issue, for its closure), or nothing
 * while CD events follow.
 */
export function shapeNextAction(stage: Stage, issueNumber: number): NextAction {
  switch (stage.stage) {
    case "deliver":
      return stage.branch === deliveryBranch(issueNumber)
        ? { stage: "deliver", reason: null }
        : { stage: "deliver", reason: "cd-failure" };
    case "ci-failed":
      return { stage: "deliver", reason: "ci-failure" };
    case "conflict":
      return { stage: "deliver", reason: "conflict" };
    case "review":
    case "done":
      return { stage: "review", reason: null };
    case "cd-failed":
      return { stage: "deliver", reason: "cd-failure" };
    default:
      return noNextAction;
  }
}
