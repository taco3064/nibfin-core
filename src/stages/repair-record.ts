// The repair record and decision comment: the contract gh-nibfin parses (Proposal
// R4.49, R4.51, R9.52). See "Repair stage" in README.md.
import { createHash } from "node:crypto";

/** The comment key of the repair record (`<!-- nibfin:repair -->`). */
export const repairCommentKey = "repair";

/** What a reader shows for a `pending` Issue (R9.52). */
export type RepairStatus = "repairing" | "waiting-for-choice" | "needs-person";

/** What the repair stage did or is doing for the stop the record covers. */
export type RepairAction = "retry" | "wait" | "advice";

/** The state line of a repair record. */
export interface RepairState {
  /** `pendingDigest` of the `pending` comment body the record covers. */
  for: string;
  status: RepairStatus;
  action: RepairAction;
  /** Every code already handled automatically on this Issue, in order. */
  handled: readonly string[];
  /** The usage-limit reset the stage waits for (`action=wait`), ISO 8601 UTC. */
  reset?: string;
}

/** The visible lines of a repair record (R4.49). */
export interface RepairText {
  category: string;
  /** One line. */
  reason: string;
  evidence: string;
  done: string;
  advice: string;
}

const statuses: readonly RepairStatus[] = [
  "repairing",
  "waiting-for-choice",
  "needs-person",
];
const actions: readonly RepairAction[] = ["retry", "wait", "advice"];

/**
 * The digest that ties a repair record to one `pending` comment: the first 16 hex
 * characters of the SHA-256 of its exact body (UTF-8, as the API returns `body`,
 * marker line included).
 */
export function pendingDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

const stateLine = new RegExp(
  "^<!-- nibfin:repair-state for=([0-9a-f]{16}) status=([a-z-]+) action=([a-z]+) " +
    "handled=([A-Z0-9_,]*)(?: reset=([0-9T:.Z-]+))? -->$",
);

/** The record body (without the `repair` marker line): state line, then R4.49 lines. */
export function formatRepairRecord(state: RepairState, text: RepairText): string {
  const reset = state.reset === undefined ? "" : ` reset=${state.reset}`;
  const line =
    `<!-- nibfin:repair-state for=${state.for} status=${state.status} ` +
    `action=${state.action} handled=${state.handled.join(",")}${reset} -->`;
  if (!stateLine.test(line)) {
    throw new TypeError(`Invalid repair state: ${line}`);
  }
  return [
    line,
    "Nibfin's repair stage looked at the latest `pending` stop.",
    "",
    `- Category: ${text.category}`,
    `- Reason: ${text.reason}`,
    `- Evidence: ${text.evidence}`,
    `- Done: ${text.done}`,
    `- Advice: ${text.advice}`,
  ].join("\n");
}

/**
 * The state of a repair record from its comment body: the first line after the
 * `repair` marker (or the first line when there is no marker). A missing or
 * unparseable state line, or `action=wait` without `reset`, is no record.
 */
export function parseRepairRecord(body: string): RepairState | undefined {
  const lines = body.split("\n");
  const first = lines[0] === "<!-- nibfin:repair -->" ? lines[1] : lines[0];
  const match = stateLine.exec(first ?? "");
  if (match === null) {
    return undefined;
  }
  const [, digest, status, action, handled, reset] = match;
  if (
    !statuses.includes(status as RepairStatus) ||
    !actions.includes(action as RepairAction) ||
    (action === "wait" && reset === undefined)
  ) {
    return undefined;
  }
  return {
    for: digest,
    status: status as RepairStatus,
    action: action as RepairAction,
    handled: handled === "" ? [] : handled.split(",").filter((code) => code !== ""),
    ...(reset === undefined ? {} : { reset }),
  };
}

/** What a reader needs to say whether a `pending` Issue is being repaired. */
export interface RepairStatusInput {
  hasPendingLabel: boolean;
  /** Nibfin's marked `pending` comment: its `body` and `updated_at`. */
  pendingComment: { body: string; updatedAt: string } | null;
  /** `created_at` of the latest `unlabeled` event for the label `pending`. */
  lastUnlabeledPendingAt: string | null;
  /** Nibfin's marked `repair` comment, parsed. */
  record: RepairState | null | undefined;
}

/**
 * Whether the `pending` comment belongs to the current `pending` label: it exists and
 * changed after `pending` was last removed (or `pending` never was).
 */
export function isPendingCurrent(input: RepairStatusInput): boolean {
  const { pendingComment, lastUnlabeledPendingAt } = input;
  return (
    pendingComment !== null &&
    (lastUnlabeledPendingAt === null ||
      Date.parse(pendingComment.updatedAt) > Date.parse(lastUnlabeledPendingAt))
  );
}

/** Whether the record covers the current `pending` comment. */
export function recordApplies(input: RepairStatusInput): boolean {
  return (
    input.hasPendingLabel &&
    isPendingCurrent(input) &&
    input.record != null &&
    input.record.for === pendingDigest(input.pendingComment!.body)
  );
}

/**
 * The reader rule (R9.52), shared by the stage and gh-nibfin: `null` without the
 * `pending` label; the record's `status` when it covers the current `pending`
 * comment; otherwise `needs-person`. A record not tied to the current `pending`
 * comment is never `repairing`.
 */
export function repairStatus(input: RepairStatusInput): RepairStatus | null {
  if (!input.hasPendingLabel) {
    return null;
  }
  return recordApplies(input) ? input.record!.status : "needs-person";
}

/** A decision comment for option `option` (R4.51), as the Dashboard writes it. */
export function formatDecision(option: number): string {
  if (!Number.isSafeInteger(option) || option < 1) {
    throw new TypeError(`Invalid option: ${option}`);
  }
  return `<!-- nibfin:decision option=${option} -->`;
}

/**
 * The option a comment chooses: the `<!-- nibfin:decision option=N -->` marker on its
 * first line, or a body that is only a number once trimmed; otherwise `undefined`.
 */
export function parseDecision(body: string): number | undefined {
  const first = body.split("\n")[0].trim();
  const marked = /^<!-- nibfin:decision option=([1-9][0-9]*) -->$/.exec(first)?.[1];
  const bare = /^[1-9][0-9]*$/.exec(body.trim())?.[0];
  const value = marked ?? bare;
  if (value === undefined) {
    return undefined;
  }
  const option = Number(value);
  return Number.isSafeInteger(option) ? option : undefined;
}
