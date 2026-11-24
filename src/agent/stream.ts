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

/**
 * The latest usage-limit report of a CLI. Only `type` (a plain identifier) and
 * `reset` (a reformatted or length-bounded time) come from the stream, so no free
 * text from the CLI reaches a comment.
 */
export interface UsageLimitReport {
  /** The provider refused the run because its usage limit was reached. */
  rejected: boolean;
  /** The limit, such as `five_hour`, when the CLI names it. */
  type?: string;
  /** When the limit resets, when the CLI reports it. */
  reset?: string;
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Claude Code's `rate_limit_event`, emitted whenever its rate-limit state changes:
 * `status` `allowed`, `allowed_warning` or `rejected`, an optional `resetsAt` in unix
 * seconds and an optional `rateLimitType`.
 */
export function claudeUsageLimit(event: AgentEvent): UsageLimitReport | undefined {
  if (event.type !== "rate_limit_event" || !isRecord(event.rate_limit_info)) {
    return undefined;
  }
  const info = event.rate_limit_info;
  const report: UsageLimitReport = { rejected: info.status === "rejected" };
  const type = stringField(info, "rateLimitType");
  if (type !== undefined && /^[a-z_]{1,64}$/.test(type)) {
    report.type = type;
  }
  const reset = unixSecondsToIso(info.resetsAt);
  if (reset !== undefined) {
    report.reset = reset;
  }
  return report;
}

/** The time of Codex's " Try again at <time>." clause: plain characters, bounded. */
const codexResetPattern = /Try again at ([\w :,/+-]{1,64}?)\.(?:\s|$)/;

/**
 * A Codex `error` or `turn.failed` event whose message says "You've hit your usage
 * limit", with the time of its "Try again at" clause when present.
 */
export function codexUsageLimit(event: AgentEvent): UsageLimitReport | undefined {
  const message = codexErrorMessage(event);
  if (message === undefined || !message.includes("hit your usage limit")) {
    return undefined;
  }
  const reset = codexResetPattern.exec(message)?.[1];
  return reset === undefined ? { rejected: true } : { rejected: true, reset };
}
