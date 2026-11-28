import { AgentError } from "../agent/index.ts";
import {
  type ActingClient,
  commentMarker,
  findMarkedComment,
  GitHubError,
  type IssueComment,
  type IssueRef,
  type MarkedComment,
  nibfinLabels,
  rateLimitOf,
  readIssueComment,
  readIssueRecord,
  readLastUnlabeled,
  type Repo,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import { NoProgressError } from "./errors.ts";
import {
  amendmentNote,
  currentCause,
  isPendingCurrent,
  parseRepairRecord,
  pendingCommentKey,
  recordApplies,
  repairCommentKey,
  type RepairState,
  type RepairStatusInput,
  scopeRequestCommentKey,
} from "./repair-record.ts";
import { unconfirmed } from "./shape-wrong.ts";

export { pendingCommentKey, scopeRequestCommentKey } from "./repair-record.ts";

/** Failures that usually pass on their own: network, GitHub or a single agent run. */
export const temporaryCodes: ReadonlySet<string> = new Set([
  "GITHUB_READ_FAILED",
  "GITHUB_WRITE_UNCONFIRMED",
  "STAGE_GIT_FAILED",
  "TOOL_INSTALL_FAILED",
  "AGENT_RUN_FAILED",
  "STAGE_RESULT_INVALID",
]);

/** Another Writer is running; its own post-stage route continues the Issue. */
const waitCode = "STAGE_WRITER_ACTIVE";

/** GitHub answered and refused a write, e.g. a body it will not take. */
const rejectedCode = "GITHUB_WRITE_REJECTED";

/** The provider's usage limit stopped the agent; it is not over before the reset. */
export const usageLimitCode = "AGENT_USAGE_LIMIT";

/** The code of a failure, if it carries one. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** A failure as its code, if any, and its message, as the Job log shows it. */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}

/** Whether `error` is the wait for another Writer, which writes nothing. */
export function isWait(error: unknown): boolean {
  return codeOf(error) === waitCode;
}

/** The URL of a workflow run, from the execution repository and run id. */
export function runUrl(repo: Repo | undefined, id: number | undefined) {
  return repo === undefined || id === undefined
    ? undefined
    : `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${id}`;
}

/**
 * The sentence a `pending` comment carries for a failure that looks temporary. Only
 * `pendingBody` writes it (a failed wake too, #776); the repair stage reads it.
 */
export const temporarySentence =
  "This looks temporary (network, GitHub or a single agent run); removing the " +
  "label retries it.";

/** The start of the usage-limit note; `it resets at` follows when the CLI said so. */
export const usageLimitLead = "The provider's usage limit was reached;";

/** When to remove `pending` after a usage-limit stop, outside the fenced message. */
function usageLimitNote(reset: string | undefined): string {
  return reset === undefined
    ? `${usageLimitLead} the CLI did not report when it ` +
        "resets. Remove the `pending` label after the limit resets to continue."
    : `${usageLimitLead} it resets at \`${reset}\`. Remove ` +
        "the `pending` label after that time to continue.";
}

/** The stage a `pending` comment names on its `- Stage:` line (only the repair stage). */
export type PendingStage = "repair";

/** What Core's own lines of a cause comment say (see `readCause`). */
export interface PendingCause {
  /** The `- Code:` value; absent for `none` or when there is no such line. */
  code: string | undefined;
  /** The `- Run:` URL of the run that stopped. */
  run: string | undefined;
  /** Whether the trailer carries `temporarySentence`. */
  temporary: boolean;
  /** The usage-limit reset as the CLI reported it, from the trailer. */
  reset: string | undefined;
  /** Whether the header says the repair stage itself failed (`- Stage: \`repair\``). */
  fromRepair: boolean;
}

/**
 * Reads a `pending` comment body. Only Core's own lines count: the header before the
 * first ```` ```text ```` line and the trailer after the last ```` ``` ```` line (the
 * whole body when there is no fence), so a failure message inside the fence cannot
 * fake a code, the temporary sentence or a reset time.
 */
export function readPendingCause(body: string): PendingCause {
  const lines = body.split("\n");
  const open = lines.indexOf("```text");
  const close = lines.lastIndexOf("```");
  const fenced = open !== -1 && close > open;
  const header = fenced ? lines.slice(0, open) : lines;
  const trailer = fenced ? lines.slice(close + 1) : lines;
  const code = header
    .map((line) => /^- Code: `([A-Z0-9_]+)`$/.exec(line)?.[1])
    .find((value) => value !== undefined);
  const reset = trailer
    .filter((line) => line.startsWith(usageLimitLead))
    .map((line) => /it resets at `([^`]+)`/.exec(line)?.[1])
    .find((value) => value !== undefined);
  const run = header
    .map((line) => /^- Run: (https:\/\/\S+)$/.exec(line)?.[1])
    .find((value) => value !== undefined);
  return {
    code,
    run,
    temporary: trailer.includes(temporarySentence),
    reset,
    fromRepair: header.includes("- Stage: `repair`"),
  };
}

const stopLead = "<!-- nibfin:stop at=";

/**
 * The hidden stop line Core writes right after the marker of a cause comment: when it
 * was written (so every write for a new stop changes the body and its `updated_at`)
 * and, with `facts`, the stop's code, run, temporary flag and reset. Values are
 * URI-encoded, so they hold no space and no `-->`.
 */
export function stopLine(at: Date, facts?: CauseFacts): string {
  const parts = [`${stopLead}${at.toISOString()}`];
  if (facts?.code !== undefined) {
    parts.push(`code=${facts.code}`);
  }
  if (facts?.run !== undefined) {
    parts.push(`run=${encodeURIComponent(facts.run)}`);
  }
  if (facts?.temporary === true) {
    parts.push("temporary=true");
  }
  if (facts?.reset !== undefined) {
    parts.push(`reset=${encodeURIComponent(facts.reset)}`);
  }
  return `${parts.join(" ")} -->`;
}

function decoded(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The facts of a stop line as `stopLine` writes it; `undefined` for any other line. */
function parseStopLine(line: string): CauseFacts | undefined {
  const match = /^<!-- nibfin:stop at=\S+((?: [a-z]+=\S+)*) -->$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const fields = new Map(
    match[1]
      .split(" ")
      .filter((part) => part !== "")
      .map((part) => {
        const split = part.indexOf("=");
        return [part.slice(0, split), part.slice(split + 1)];
      }),
  );
  const code = fields.get("code");
  return {
    code: code !== undefined && /^[A-Z0-9_]+$/.test(code) ? code : undefined,
    run: decoded(fields.get("run")),
    temporary: fields.get("temporary") === "true",
    reset: decoded(fields.get("reset")),
  };
}

/** A cause comment: its marker key and its body as stored, marker line included. */
export interface CauseText {
  key: string;
  body: string;
}

/**
 * What Core's own lines of a cause comment say. A `pending` comment is read by
 * `readPendingCause`. A `scope-request` comment also holds the Scope agent's reason
 * and request text, so only its first two lines count: the exact marker, then a stop
 * line, whose facts it returns (a failed write's code, run, temporary flag and reset).
 * Anything from line 3 on is never read, and a comment without that stop line (one
 * written before Core wrote it) has no code. A Scope comment never names the repair
 * stage.
 */
export function readCause(comment: CauseText): PendingCause {
  if (comment.key !== scopeRequestCommentKey) {
    return readPendingCause(comment.body);
  }
  const [marker, line = ""] = comment.body.split("\n");
  const facts =
    marker === commentMarker(scopeRequestCommentKey) ? parseStopLine(line) : undefined;
  return {
    code: facts?.code,
    run: facts?.run,
    temporary: facts?.temporary ?? false,
    reset: facts?.reset,
    fromRepair: false,
  };
}

function isTemporary(error: unknown, code: string | undefined): boolean {
  if (error instanceof NoProgressError) {
    return error.temporary;
  }
  if (error instanceof GitHubError && rateLimitOf(error.cause) !== undefined) {
    return true;
  }
  return code !== undefined && temporaryCodes.has(code);
}

/** The facts of a stop that a cause comment states, without the stage. */
export type CauseFacts = Omit<PendingCause, "fromRepair">;

/**
 * The facts `pendingBody` states for `error` in run `url`: its code, the run, whether
 * it looks temporary and, for a usage limit only, the reset the CLI reported.
 */
export function pendingCauseOf(error: unknown, url: string | undefined): CauseFacts {
  const code = codeOf(error);
  const reset =
    code === usageLimitCode && error instanceof AgentError
      ? error.usageLimitReset
      : undefined;
  return { code, run: url, temporary: isTemporary(error, code), reset };
}

/**
 * The `pending` comment body for `error`. Without `withMessage` the fenced message
 * block is replaced by a pointer to the run log, where the full message always goes.
 */
export function pendingBody(
  error: unknown,
  url: string | undefined,
  withMessage = true,
  stage?: PendingStage,
): string {
  const { code, temporary, reset } = pendingCauseOf(error, url);
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    "Nibfin stopped and needs a person.",
    "",
    `- Code: \`${code ?? "none"}\``,
    `- Run: ${url ?? "unknown"}`,
    ...(stage === undefined ? [] : [`- Stage: \`${stage}\``]),
    "",
    ...(withMessage
      ? ["```text", message, "```"]
      : ["The full message is in the run log."]),
    "",
  ];
  if (code === usageLimitCode) {
    lines.push(usageLimitNote(reset), "");
  }
  if (temporary) {
    lines.push(temporarySentence, "");
  }
  lines.push("Remove the `pending` label to continue.");
  return lines.join("\n");
}

/**
 * Upserts the marked comment `key` on `issue` with `render(true)`. When GitHub
 * rejects it (`GITHUB_WRITE_REJECTED`, e.g. a very long message), it writes
 * `render(false)`, the body without the message, once more. Any other failure is
 * thrown.
 */
export async function upsertPersonComment(
  client: ActingClient,
  issue: IssueRef,
  key: string,
  render: (withMessage: boolean) => string,
): Promise<MarkedComment> {
  try {
    return await upsertMarkedComment(client, issue, key, render(true));
  } catch (failure) {
    if (codeOf(failure) !== rejectedCode) {
      throw failure;
    }
    return upsertMarkedComment(client, issue, key, render(false));
  }
}

/**
 * Upserts the cause comment `key` of a new stop on `issue`: a fresh stop line (`stopLine`
 * at `now()`, with `facts` when given) right after the marker, then `render`'s text,
 * through `upsertPersonComment` (both bodies share the stop line). The stop line makes
 * every write for a new stop change the body, even when the text is the same as before,
 * so its `updated_at` moves past the last removal of `pending`.
 */
export async function upsertCauseComment(
  client: ActingClient,
  issue: IssueRef,
  key: string,
  render: (withMessage: boolean) => string,
  facts?: CauseFacts,
  now: () => Date = () => new Date(),
): Promise<MarkedComment> {
  const line = stopLine(now(), facts);
  return upsertPersonComment(
    client,
    issue,
    key,
    (withMessage) => `${line}\n${render(withMessage)}`,
  );
}

/**
 * Asks a person to act on `issue` after `error`: upserts the marked `pending`
 * comment and adds `pending`, confirmed by the read-back labels. Nothing runs for
 * the Issue while `pending` is present; removing it is the go-ahead. A
 * `STAGE_WRITER_ACTIVE` error is a wait, not a failure, and writes nothing. When
 * GitHub rejects the comment (`GITHUB_WRITE_REJECTED`, e.g. a very long message), it
 * writes it once more without the message, then adds the label as usual. With
 * `stage` the comment names the stage that failed (`- Stage:`); the repair stage
 * passes `repair`, so it does not start again for that stop (Proposal R4.50).
 * Returns whether it wrote.
 */
export async function requestPerson(
  client: ActingClient,
  issue: IssueRef,
  error: unknown,
  url: string | undefined,
  stage?: PendingStage,
): Promise<boolean> {
  if (isWait(error)) {
    return false;
  }
  await upsertCauseComment(client, issue, pendingCommentKey, (withMessage) =>
    pendingBody(error, url, withMessage, stage),
  );
  await addPendingLabel(client, issue);
  return true;
}

/** Adds `pending`, confirmed by the read-back labels. */
async function addPendingLabel(client: ActingClient, issue: IssueRef): Promise<void> {
  const labels = await setLabels(client, issue, { add: [nibfinLabels.pending] });
  if (!labels.includes(nibfinLabels.pending)) {
    throw unconfirmed("add pending", "The read-back labels lack pending");
  }
}

/** A cause comment as REST reads it, with its marker key. */
export interface CauseComment extends IssueComment {
  key: string;
}

/** The reader rule's inputs (R9.52) with the chosen cause comment as REST reads it. */
export interface RepairInput extends RepairStatusInput {
  pendingComment: CauseComment | null;
  record: RepairState | null;
}

/** Nibfin's marked comment `key` on `issue` by REST (for `updated_at`), if any. */
async function readCauseComment(
  client: ActingClient,
  issue: IssueRef,
  key: string,
): Promise<CauseComment | null> {
  const marked = await findMarkedComment(client, issue, key);
  return marked === undefined
    ? null
    : { ...(await readIssueComment(client, issue, marked.id)), key };
}

/**
 * Reads the reader rule's inputs for `issue`: Nibfin's marked `pending` and
 * `scope-request` comments (by REST, for `updated_at`), when `pending` was last
 * removed, and Nibfin's marked `repair` comment, parsed. `pendingComment` is the one
 * `currentCause` picks, or the `pending` comment (not current) when neither is.
 * `hasPendingLabel` is passed through as the caller read it.
 */
export async function readRepairInput(
  client: ActingClient,
  issue: IssueRef,
  hasPendingLabel: boolean,
): Promise<RepairInput> {
  const pending = await readCauseComment(client, issue, pendingCommentKey);
  const scope = await readCauseComment(client, issue, scopeRequestCommentKey);
  const lastUnlabeled = await readLastUnlabeled(client, issue, nibfinLabels.pending);
  const repair = await findMarkedComment(client, issue, repairCommentKey);
  const record = repair === undefined ? null : (parseRepairRecord(repair.body) ?? null);
  return {
    hasPendingLabel,
    pendingComment: currentCause([pending, scope], lastUnlabeled) ?? pending,
    lastUnlabeledPendingAt: lastUnlabeled,
    record,
  };
}

/**
 * A Job that failed before Core could report a cause (#776): the workflow's last step
 * writes it. Not temporary, so the repair stage hands it to the repair agent.
 */
export class JobFailedError extends Error {
  readonly code = "JOB_FAILED";
  readonly stage: string;
  readonly amendment: boolean;

  /** With `amendment`, the message adds that the repair's amendment may be partial. */
  constructor(stage: string, amendment = false) {
    const note = amendment ? ` ${amendmentNote}` : "";
    super(
      `The \`${stage}\` Job failed before Nibfin could report a cause (checkout, ` +
        `image pull, container start or clean up); see the run log.${note}`,
    );
    this.name = "JobFailedError";
    this.stage = stage;
    this.amendment = amendment;
  }
}

/** The repair actions whose Job is still doing its step (the route resumes both). */
const repairInProgress: ReadonlySet<string> = new Set(["agent", "amend"]);

/**
 * Asks a person once after a failure that Core may already have reported (#776): the
 * failed Job's last step (`stage` is the Job's stage) and a failed wake (no `stage`).
 * The labels are read first.
 *
 * 1. Not `repair` and `pending` is there: nothing; the standing stop's comment stays.
 *    For `repair` it goes on only while Nibfin's repair record covers the current
 *    cause comment as `repairing` `agent` or `amend` (the repair has not done its
 *    step); otherwise nothing, so a late failure never undoes the repair's result.
 * 2. The current cause comment (`currentCause`) names this run (`readCause`; a Scope
 *    comment only after a failed write): only `pending` is added, so Core's specific
 *    cause is never overwritten.
 * 3. Otherwise `requestPerson`, naming the repair stage for `repair`. Under an `amend`
 *    record a `JobFailedError` adds that the amendment may be partly applied.
 *
 * Returns whether it wrote.
 */
export async function askPersonOnce(
  client: ActingClient,
  issue: IssueRef,
  error: unknown,
  url: string | undefined,
  stage?: string,
): Promise<boolean> {
  const { labels } = await readIssueRecord(client, issue);
  const hasPendingLabel = labels.includes(nibfinLabels.pending);
  const repair = stage === "repair";
  // Any other Job only acts without `pending`; a repair Job only with it.
  if (hasPendingLabel !== repair) {
    return false;
  }
  const input = await readRepairInput(client, issue, hasPendingLabel);
  let failure = error;
  if (repair) {
    const { record } = input;
    if (
      !recordApplies(input) ||
      record!.status !== "repairing" ||
      !repairInProgress.has(record!.action)
    ) {
      return false;
    }
    if (record!.action === "amend" && error instanceof JobFailedError) {
      failure = new JobFailedError(error.stage, true);
    }
  }
  const comment = input.pendingComment;
  if (
    url !== undefined &&
    comment !== null &&
    isPendingCurrent(input) &&
    readCause(comment).run === url
  ) {
    await addPendingLabel(client, issue);
    return true;
  }
  return requestPerson(client, issue, failure, url, repair ? "repair" : undefined);
}
