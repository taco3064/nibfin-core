import { isRecord, type JsonRecord, stringField } from "./json.ts";

/** One JSON line of a CLI's headless output stream. */
export type AgentEvent = JsonRecord;

/** Codex's auth-refresh failures end with one of these sentences. */
const codexReloginSentences = [
  "Please log out and sign in again.",
  "Please sign in again.",
];

/**
 * Claude Code marks a rejected login with `error: "authentication_failed"` on an
 * assistant message or on a `system/api_retry` message.
 */
export function isClaudeLoginSignal(event: AgentEvent): boolean {
  if (event.error !== "authentication_failed") {
    return false;
  }
  return (
    event.type === "assistant" ||
    (event.type === "system" && event.subtype === "api_retry")
  );
}

/** The final `result` message of a successful Claude Code run. */
export function claudeResult(event: AgentEvent): string | undefined {
  if (event.type !== "result" || event.is_error === true) {
    return undefined;
  }
  return stringField(event, "result");
}

function codexErrorMessage(event: AgentEvent): string | undefined {
  if (event.type === "error") {
    return stringField(event, "message");
  }
  if (event.type === "turn.failed" && isRecord(event.error)) {
    return stringField(event.error, "message");
  }
  return undefined;
}

/** A Codex `error` or `turn.failed` event caused by a login that cannot refresh. */
export function isCodexLoginSignal(event: AgentEvent): boolean {
  const message = codexErrorMessage(event);
  return (
    message !== undefined &&
    codexReloginSentences.some((sentence) => message.includes(sentence))
  );
}
