// The repair stage, deterministic part (#777, Proposal R4.40–R4.52): it runs inside
// the `nibfin route --issue` Job for an Issue with `pending`, reads the `pending`
// comment's code and clears the causes that need no person.
import { setTimeout as sleepFor } from "node:timers/promises";
import {
  type ActingClient,
  deriveStage,
  findMarkedComment,
  freshReads,
  type IssueRef,
  nibfinLabels,
  readIssueComment,
  readIssueSnapshot,
  readLastUnlabeled,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  type PendingCause,
  pendingCommentKey,
  readPendingCause,
  usageLimitCode,
} from "./pending.ts";
import {
  formatRepairRecord,
  isPendingCurrent,
  parseRepairRecord,
  pendingDigest,
  recordApplies,
  type RepairAction,
  repairCommentKey,
  type RepairState,
  type RepairStatus,
  type RepairText,
} from "./repair-record.ts";
import { unconfirmed } from "./shape-wrong.ts";

/** Nibfin's current `pending` comment, as REST reads it. */
export interface PendingComment {
  id: number;
  body: string;
  url: string;
  updatedAt: string;
  /** `pendingDigest(body)`. */
  digest: string;
}

/**
 * Why the repair stage runs: `new` decides for the current stop (`pending` is `null`
 * when no Nibfin `pending` comment was written since `pending` was last removed);
 * `resume` continues the `repairing` record that covers it. `record` is the Issue's
 * latest record, whichever stop it covers (its `handled` list carries over).
 */
export interface RepairNeed {
  kind: "new" | "resume";
  pending: PendingComment | null;
  record: RepairState | null;
}

/**
 * The repair need of an Issue whose derived stage is `ineligible (pending)`:
 * `null` (nothing to do) when the current `pending` comment names the repair stage
 * (R4.50) or a record covers it that is not `repairing`; `resume` when a `repairing`
 * record covers it; `new` otherwise. It reads the marked `pending` comment (by REST,
 * for `updated_at`), the Issue's events and the marked `repair` comment.
 */
export async function readRepairNeed(
  client: ActingClient,
  issue: IssueRef,
): Promise<RepairNeed | null> {
  const marked = await findMarkedComment(client, issue, pendingCommentKey);
  const comment =
    marked === undefined ? null : await readIssueComment(client, issue, marked.id);
  const lastUnlabeled = await readLastUnlabeled(client, issue, nibfinLabels.pending);
  const repair = await findMarkedComment(client, issue, repairCommentKey);
  const record = repair === undefined ? null : (parseRepairRecord(repair.body) ?? null);
  const input = {
    hasPendingLabel: true,
    pendingComment: comment,
    lastUnlabeledPendingAt: lastUnlabeled,
    record,
  };
  const pending =
    comment !== null && isPendingCurrent(input)
      ? { ...comment, digest: pendingDigest(comment.body) }
      : null;
  if (pending !== null && readPendingCause(pending.body).fromRepair) {
    return null;
  }
  if (recordApplies(input)) {
    return record!.status === "repairing" ? { kind: "resume", pending, record } : null;
  }
  return { kind: "new", pending, record };
}

/**
 * How long a usage-limit wait may last, counted from the Job's start: GitHub ends a
 * job after 360 minutes (the `timeout-minutes` default and the GitHub-hosted limit,
 * https://docs.github.com/en/actions/reference/limits), less a margin for the
 * dispatch after the wait.
 */
export const jobLimitMinutes = 330;

/** A usage-limit wait ends one minute after the reported reset. */
const resetMarginMs = 60_000;

/** The clock of the repair stage; tests replace it. */
export interface RepairClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** When this Job's process started (epoch ms). */
  jobStart: number;
}

export const systemClock: RepairClock = {
  now: () => Date.now(),
  sleep: (ms) => sleepFor(ms),
  jobStart: Math.round(performance.timeOrigin),
};

/**
 * What `runRepair` ended with: `released` (`pending` removed, the route dispatches
 * once more), `advised` (the record holds advice, `pending` stays) or `stopped`
 * (the state changed during the wait; nothing written).
 */
export type RepairOutcome = "released" | "advised" | "stopped";

const temporaryCategory = "external temporary problem";
const usageCategory = "external temporary problem (provider usage limit)";
const unknownCategory = "not classified";

interface Decision {
  status: RepairStatus;
  action: RepairAction;
  handled: readonly string[];
  reset?: string;
  text: Omit<RepairText, "evidence">;
}

const keepPending = "Nothing; `pending` stays.";

function advice(
  category: string,
  handled: readonly string[],
  reason: string,
  next: string,
  done = keepPending,
): Decision {
  return {
    status: "needs-person",
    action: "advice",
    handled,
    text: { category, reason, done, advice: next },
  };
}

/** A reset Nibfin can wait for: ISO 8601 UTC, within this Job's time limit. */
function waitableReset(reset: string | undefined, clock: RepairClock): boolean {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  if (reset === undefined || !iso.test(reset) || Number.isNaN(Date.parse(reset))) {
    return false;
  }
  return Date.parse(reset) + resetMarginMs <= clock.jobStart + jobLimitMinutes * 60_000;
}

function usageLimit(
  cause: PendingCause,
  handled: readonly string[],
  clock: RepairClock,
): Decision {
  const { reset } = cause;
  if (waitableReset(reset, clock)) {
    return {
      status: "repairing",
      action: "wait",
      handled: [...handled, usageLimitCode],
      reset,
      text: {
        category: usageCategory,
        reason: `The provider's usage limit was reached; it resets at \`${reset}\`.`,
        done:
          `Nibfin is waiting in its route Job until \`${reset}\` plus one minute, ` +
          "then removes `pending` and dispatches the stage again.",
        advice:
          "None needed. To stop the wait, add `pause` or remove `pending` yourself.",
      },
    };
  }
  if (reset === undefined) {
    return advice(
      usageCategory,
      handled,
      "The provider's usage limit was reached; the CLI did not report when it resets.",
      "Remove the `pending` label after the provider's usage limit resets.",
    );
  }
  return advice(
    usageCategory,
    handled,
    `The provider's usage limit was reached; it resets at \`${reset}\`, which ` +
      "Nibfin cannot wait for inside one Job.",
    `Remove the \`pending\` label after \`${reset}\`.`,
  );
}

/** The decision order of the repair stage for a new stop (README "Repair stage"). */
function decide(
  cause: PendingCause | null,
  handled: readonly string[],
  clock: RepairClock,
): Decision {
  const code = cause?.code;
  const unknown = advice(
    unknownCategory,
    handled,
    cause === null
      ? "No Nibfin `pending` comment was written since `pending` was last removed."
      : `The repair stage cannot decide the code \`${code ?? "none"}\` by itself yet.`,
    "Read the latest Nibfin comment on this Issue, fix what it names, then remove " +
      "the `pending` label.",
  );
  if (cause === null || code === undefined) {
    return unknown;
  }
  if (handled.includes(code)) {
    return advice(
      code === usageLimitCode ? usageCategory : temporaryCategory,
      handled,
      `This Issue stopped for \`${code}\` a second time.`,
      `This is the second stop for \`${code}\`; check the cause in the \`pending\` ` +
        "comment and its run, then remove the `pending` label.",
      "Nothing; a second stop for the same code is not handled automatically, so " +
        "`pending` stays.",
    );
  }
  if (code === usageLimitCode) {
    return usageLimit(cause, handled, clock);
  }
  if (cause.temporary) {
    return {
      status: "repairing",
      action: "retry",
      handled: [...handled, code],
      text: {
        category: temporaryCategory,
        reason:
          `The stop for \`${code}\` looks temporary (network, GitHub or a ` +
          "single agent run).",
        done:
          "Nibfin removes `pending` and dispatches the stage GitHub's current state " +
          "calls for, once.",
        advice:
          `None needed. If it stops for \`${code}\` again, \`pending\` stays ` +
          "for a person.",
      },
    };
  }
  return unknown;
}

function evidence(pending: PendingComment | null): string {
  if (pending === null) {
    return "no Nibfin `pending` comment since `pending` was last removed";
  }
  const { code, run } = readPendingCause(pending.body);
  const link = `[the \`pending\` comment](${pending.url})`;
  return `code \`${code ?? "none"}\`, ${link}${run === undefined ? "" : `, run ${run}`}`;
}

/** Removes `pending`, confirmed by the read-back labels (W2). */
async function release(client: ActingClient, issue: IssueRef): Promise<RepairOutcome> {
  const labels = await setLabels(client, issue, { remove: [nibfinLabels.pending] });
  if (labels.includes(nibfinLabels.pending)) {
    throw unconfirmed("remove pending", "The read-back labels still have pending");
  }
  return "released";
}

/**
 * Sleeps until one minute after `reset`, then re-reads GitHub: it continues to W2 only
 * while the Issue still derives `ineligible (pending)` and its `repairing` record
 * still covers the same `pending` comment (`digest`); otherwise it stops unwritten.
 */
async function waitAndRelease(
  client: ActingClient,
  issue: IssueRef,
  reset: string,
  digest: string,
  clock: RepairClock,
  log: (line: string) => void,
): Promise<RepairOutcome> {
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  const until = Date.parse(reset) + resetMarginMs;
  const left = Math.max(0, until - clock.now());
  log(`${name}: repair: waiting ${Math.ceil(left / 1000)}s for the usage limit reset`);
  await clock.sleep(left);
  freshReads(client);
  const stage = deriveStage(await readIssueSnapshot(client, issue, issue.number));
  const need =
    stage.stage === "ineligible" && stage.reason === "pending"
      ? await readRepairNeed(client, issue)
      : null;
  if (need?.kind !== "resume" || need.pending?.digest !== digest) {
    log(`${name}: repair: the Issue changed during the wait; nothing more to do`);
    return "stopped";
  }
  return release(client, issue);
}

/**
 * Runs the repair stage for `need`. A new stop is decided in order: no current
 * `pending` comment or no code → advice (`not classified`); a code already handled →
 * advice (R4.47); `AGENT_USAGE_LIMIT` → wait when its reset is ISO 8601 UTC and one
 * minute after it lies within `jobLimitMinutes` of the Job's start, else advice
 * (R4.43); the temporary sentence → retry (R4.42); anything else → advice. It writes
 * the record (W1), then for `retry` removes `pending` (W2) and for `wait` sleeps,
 * re-reads and removes it. `resume` skips W1.
 */
export async function runRepair(
  client: ActingClient,
  issue: IssueRef,
  need: RepairNeed,
  clock: RepairClock,
  log: (line: string) => void,
): Promise<RepairOutcome> {
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  if (need.kind === "resume") {
    const record = need.record!;
    const digest = need.pending!.digest;
    log(`${name}: repair: resuming ${record.action}`);
    return record.action === "wait"
      ? waitAndRelease(client, issue, record.reset!, digest, clock, log)
      : release(client, issue);
  }
  const { pending } = need;
  const cause = pending === null ? null : readPendingCause(pending.body);
  const decision = decide(cause, need.record?.handled ?? [], clock);
  const digest = pending?.digest ?? pendingDigest("");
  const state: RepairState = {
    for: digest,
    status: decision.status,
    action: decision.action,
    handled: decision.handled,
    ...(decision.reset === undefined ? {} : { reset: decision.reset }),
  };
  const body = formatRepairRecord(state, {
    ...decision.text,
    evidence: evidence(pending),
  });
  await upsertMarkedComment(client, issue, repairCommentKey, body);
  log(`${name}: repair: ${decision.text.category}, ${decision.action}`);
  if (decision.action === "advice") {
    return "advised";
  }
  if (decision.action === "wait") {
    return waitAndRelease(client, issue, decision.reset!, digest, clock, log);
  }
  return release(client, issue);
}
