import { AgentError } from "../agent/index.ts";
import {
  type ActingClient,
  GitHubError,
  type IssueRef,
  type MarkedComment,
  nibfinLabels,
  rateLimitOf,
  type Repo,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import { NoProgressError } from "./errors.ts";
import { unconfirmed } from "./shape-wrong.ts";

/** The comment key of the note that asks a person to act (#674). */
export const pendingCommentKey = "pending";

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
 * The sentence a `pending` comment carries for a failure that looks temporary. The wake
 * failure of `nibfin-events.yml` writes it word for word; the repair stage reads it.
 */
export const temporarySentence =
  "This looks temporary (network, GitHub or a single agent run); removing the " +
  "label retries it.";

/** The start of the usage-limit note; `it resets at` follows when the CLI said so. */
export const usageLimitLead = "The provider's usage limit was reached;";

/** When to remove `pending` after a usage-limit stop, outside the fenced message. */
function usageLimitNote(error: unknown): string {
  const reset = error instanceof AgentError ? error.usageLimitReset : undefined;
  return reset === undefined
    ? `${usageLimitLead} the CLI did not report when it ` +
        "resets. Remove the `pending` label after the limit resets to continue."
    : `${usageLimitLead} it resets at \`${reset}\`. Remove ` +
        "the `pending` label after that time to continue.";
}

/** The stage a `pending` comment names on its `- Stage:` line (only the repair stage). */
export type PendingStage = "repair";

/** What Core's own lines of a `pending` comment say (see `readPendingCause`). */
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

function isTemporary(error: unknown, code: string | undefined): boolean {
  if (error instanceof NoProgressError) {
    return error.temporary;
  }
  if (error instanceof GitHubError && rateLimitOf(error.cause) !== undefined) {
    return true;
  }
  return code !== undefined && temporaryCodes.has(code);
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
  const code = codeOf(error);
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
    lines.push(usageLimitNote(error), "");
  }
  if (isTemporary(error, code)) {
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
  await upsertPersonComment(client, issue, pendingCommentKey, (withMessage) =>
    pendingBody(error, url, withMessage, stage),
  );
  const labels = await setLabels(client, issue, { add: [nibfinLabels.pending] });
  if (!labels.includes(nibfinLabels.pending)) {
    throw unconfirmed("add pending", "The read-back labels lack pending");
  }
  return true;
}
