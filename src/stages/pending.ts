import {
  type ActingClient,
  type IssueRef,
  nibfinLabels,
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

/** The code of a failure, if it carries one. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** The URL of a workflow run, from the execution repository and run id. */
export function runUrl(repo: Repo | undefined, id: number | undefined) {
  return repo === undefined || id === undefined
    ? undefined
    : `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${id}`;
}

function isTemporary(error: unknown, code: string | undefined): boolean {
  if (error instanceof NoProgressError) {
    return error.temporary;
  }
  return code !== undefined && temporaryCodes.has(code);
}

/** The `pending` comment body for `error`. */
export function pendingBody(error: unknown, url: string | undefined): string {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    "Nibfin stopped and needs a person.",
    "",
    `- Code: \`${code ?? "none"}\``,
    `- Run: ${url ?? "unknown"}`,
    "",
    "```text",
    message,
    "```",
    "",
  ];
  if (isTemporary(error, code)) {
    lines.push(
      "This looks temporary (network, GitHub or a single agent run); removing the " +
        "label retries it.",
      "",
    );
  }
  lines.push("Remove the `pending` label to continue.");
  return lines.join("\n");
}

/**
 * Asks a person to act on `issue` after `error`: upserts the marked `pending`
 * comment and adds `pending`, confirmed by the read-back labels. Nothing runs for
 * the Issue while `pending` is present; removing it is the go-ahead. A
 * `STAGE_WRITER_ACTIVE` error is a wait, not a failure, and writes nothing.
 * Returns whether it wrote.
 */
export async function requestPerson(
  client: ActingClient,
  issue: IssueRef,
  error: unknown,
  url: string | undefined,
): Promise<boolean> {
  if (codeOf(error) === waitCode) {
    return false;
  }
  await upsertMarkedComment(client, issue, pendingCommentKey, pendingBody(error, url));
  const labels = await setLabels(client, issue, { add: [nibfinLabels.pending] });
  if (!labels.includes(nibfinLabels.pending)) {
    throw unconfirmed("add pending", "The read-back labels lack pending");
  }
  return true;
}
