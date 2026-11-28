// The repair stage, deterministic part (#777, Proposal R4.40–R4.52): it runs inside
// the `nibfin route --issue` Job for an Issue with `pending`, reads the `pending`
// comment's code and clears the causes that need no person.
import { setTimeout as sleepFor } from "node:timers/promises";
import {
  type ActingClient,
  deriveStage,
  freshReads,
  type IssueRef,
  nibfinLabels,
  readIssueSnapshot,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  type PendingCause,
  readPendingCause,
  readRepairInput,
  usageLimitCode,
} from "./pending.ts";
import {
  amendmentNote,
  formatRepairRecord,
  isPendingCurrent,
  pendingDigest,
  recordApplies,
  type RepairAction,
  repairCommentKey,
  type RepairState,
  type RepairStatus,
  type RepairText,
} from "./repair-record.ts";
import { StageError } from "./errors.ts";
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
  const input = await readRepairInput(client, issue, true);
  const { pendingComment: comment, record } = input;
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
 * once more), `advised` (the record holds advice, `pending` stays), `agent` (the
 * repair agent has its record and runs in a repair Job) or `stopped` (nothing more
 * to write now: the state changed during the wait, consent was asked, a repair run
 * is waiting, or a CI rerun is still running).
 */
export type RepairOutcome = "released" | "advised" | "agent" | "stopped";

/** A dispatch plan of the repair stage, as the route's `planDispatch` gives it. */
export type RepairDispatchPlan =
  | { kind: "none" }
  | { kind: "waiting"; runId: number }
  | { kind: "consent" }
  | { kind: "ready"; assignee: number };

/** How the route dispatches the repair agent for the Issue (#778). */
export interface RepairDispatcher {
  /** Plans the `repair` dispatch; `consent` has already written `pause`. */
  plan: () => Promise<RepairDispatchPlan>;
  dispatch: (assignee: number) => Promise<void>;
  /** The id of a repair run of the Issue that has not started, if any. */
  waitingRun: () => Promise<number | undefined>;
}

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

/** The stop goes to the repair agent (#778). */
const toAgent = "agent";

/**
 * The decision order of the repair stage for a new stop (README "Repair stage"): what
 * the code cannot decide goes to the repair agent (R4.40).
 */
function decide(
  cause: PendingCause | null,
  handled: readonly string[],
  clock: RepairClock,
): Decision | typeof toAgent {
  if (cause === null) {
    return advice(
      unknownCategory,
      handled,
      "No Nibfin `pending` comment was written since `pending` was last removed.",
      "Read the latest Nibfin comment on this Issue, fix what it names, then remove " +
        "the `pending` label.",
    );
  }
  const { code } = cause;
  if (code === undefined) {
    return toAgent;
  }
  if (code === usageLimitCode && handled.includes(code)) {
    return advice(
      usageCategory,
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
  // A second stop for a handled code: the agent writes options or advice (R4.47).
  if (cause.temporary && !handled.includes(code)) {
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
  return toAgent;
}

/** The record's evidence of the stop: its code, `pending` comment and run. */
export function pendingEvidence(pending: PendingComment | null): string {
  if (pending === null) {
    return "no Nibfin `pending` comment since `pending` was last removed";
  }
  const { code, run } = readPendingCause(pending.body);
  const link = `[the \`pending\` comment](${pending.url})`;
  return `code \`${code ?? "none"}\`, ${link}${run === undefined ? "" : `, run ${run}`}`;
}

/** Removes `pending`, confirmed by the read-back labels (W2). */
export async function release(
  client: ActingClient,
  issue: IssueRef,
): Promise<RepairOutcome> {
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

/** The record of a stop handed to the repair agent (#778), written before dispatch. */
function agentDecision(handled: readonly string[]): Decision {
  return {
    status: "repairing",
    action: "agent",
    handled,
    text: {
      category: "being classified",
      reason: "Nibfin's repair agent is looking at this stop.",
      done: "Dispatched the repair agent.",
      advice: "None needed while it works. To stop it, add `pause` or remove `pending`.",
    },
  };
}

const noRunner = (handled: readonly string[]) =>
  advice(
    unknownCategory,
    handled,
    "No runner of an Assignee can run the repair agent.",
    "Read the latest Nibfin comment on this Issue, fix what it names, then remove " +
      "the `pending` label; or start a runner of an Assignee, then remove `pending` " +
      "to have the repair agent look at the next stop.",
  );

/**
 * A stop for the repair agent: the dispatch is planned before any record is written,
 * so a record `repairing agent` exists only when a repair Job will run. `none` →
 * advice; `consent` → nothing more (the Issue has `pause` and the consent comments;
 * removing `pause` plans again); `waiting` → W1 only (the queued repair run picks it
 * up); `ready` → W1, then the dispatch.
 */
async function handToAgent(
  client: ActingClient,
  issue: IssueRef,
  need: RepairNeed,
  dispatcher: RepairDispatcher,
  log: (line: string) => void,
): Promise<RepairOutcome> {
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  const handled = need.record?.handled ?? [];
  const plan = await dispatcher.plan();
  if (plan.kind === "consent") {
    log(`${name}: repair: waiting for the Assignees' consent before the repair agent`);
    return "stopped";
  }
  const decision = plan.kind === "none" ? noRunner(handled) : agentDecision(handled);
  await writeRecord(client, issue, need.pending, decision);
  log(`${name}: repair: ${decision.text.category}, ${decision.action}`);
  if (plan.kind === "none") {
    return "advised";
  }
  if (plan.kind === "ready") {
    await dispatcher.dispatch(plan.assignee);
  }
  return "agent";
}

/** W1: upserts the record of `decision` for `pending`'s stop. */
async function writeRecord(
  client: ActingClient,
  issue: IssueRef,
  pending: PendingComment | null,
  decision: Decision,
): Promise<RepairState> {
  const state: RepairState = {
    for: pending?.digest ?? pendingDigest(""),
    status: decision.status,
    action: decision.action,
    handled: decision.handled,
    ...(decision.reset === undefined ? {} : { reset: decision.reset }),
  };
  const body = formatRepairRecord(state, {
    ...decision.text,
    evidence: pendingEvidence(pending),
  });
  await upsertMarkedComment(client, issue, repairCommentKey, body);
  return state;
}

/**
 * Resumes a record `repairing agent` or `amend`: a repair run of the Issue that has
 * not started will do the work, so nothing is written. Without one, the repair Job
 * for this stop ended without a result (or was never dispatched): it is not
 * dispatched again, and `STAGE_REPAIR_ENDED` makes the route end the stop as R4.50
 * says.
 */
async function resumeAgent(
  action: RepairAction,
  dispatcher: RepairDispatcher,
  name: string,
  log: (line: string) => void,
): Promise<RepairOutcome> {
  const waiting = await dispatcher.waitingRun();
  if (waiting !== undefined) {
    log(`${name}: repair: repair run ${waiting} is waiting to start`);
    return "stopped";
  }
  const partly = action === "amend" ? ` ${amendmentNote}` : "";
  throw new StageError(
    "STAGE_REPAIR_ENDED",
    "The repair Job for this stop ended without a result, so the repair agent's " +
      `step was not completed.${partly}`,
  );
}

/**
 * Resumes a record `repairing rerun`: while a required check of the Issue's open pull
 * request is still pending, the CI completion wake resumes it; otherwise (no open pull
 * request, or CI completed) `pending` is removed.
 */
async function resumeRerun(
  client: ActingClient,
  issue: IssueRef,
  name: string,
  log: (line: string) => void,
): Promise<RepairOutcome> {
  const snapshot = await readIssueSnapshot(client, issue, issue.number);
  const open = snapshot.pullRequests.find((pull) => pull.state === "open");
  const running = open?.ci?.results.some((result) => result.state === "pending");
  if (running === true) {
    log(`${name}: repair: the re-run CI of ${open!.url} is still running`);
    return "stopped";
  }
  return release(client, issue);
}

/**
 * Runs the repair stage for `need`. A new stop is decided in order: no current
 * `pending` comment → advice (`not classified`); a second `AGENT_USAGE_LIMIT` →
 * advice (R4.47); `AGENT_USAGE_LIMIT` → wait when its reset is ISO 8601 UTC and one
 * minute after it lies within `jobLimitMinutes` of the Job's start, else advice
 * (R4.43); the temporary sentence for a code not handled yet → retry (R4.42);
 * anything else (no code, a second stop for a handled code, any other code) → the
 * repair agent (#778, `handToAgent`). It writes the record (W1), then for `retry`
 * removes `pending` (W2) and for `wait` sleeps, re-reads and removes it. `resume`
 * skips W1: `retry` releases, `wait` waits for the time left, `rerun` releases once
 * CI completed, and `agent` or `amend` checks for a waiting repair run.
 */
export async function runRepair(
  client: ActingClient,
  issue: IssueRef,
  need: RepairNeed,
  clock: RepairClock,
  log: (line: string) => void,
  dispatcher: RepairDispatcher,
): Promise<RepairOutcome> {
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  if (need.kind === "resume") {
    const record = need.record!;
    const digest = need.pending!.digest;
    log(`${name}: repair: resuming ${record.action}`);
    switch (record.action) {
      case "wait":
        return waitAndRelease(client, issue, record.reset!, digest, clock, log);
      case "agent":
      case "amend":
        return resumeAgent(record.action, dispatcher, name, log);
      case "rerun":
        return resumeRerun(client, issue, name, log);
      default:
        return release(client, issue);
    }
  }
  const { pending } = need;
  const cause = pending === null ? null : readPendingCause(pending.body);
  const decision = decide(cause, need.record?.handled ?? [], clock);
  if (decision === toAgent) {
    return handToAgent(client, issue, need, dispatcher, log);
  }
  const state = await writeRecord(client, issue, pending, decision);
  log(`${name}: repair: ${decision.text.category}, ${decision.action}`);
  if (decision.action === "advice") {
    return "advised";
  }
  if (decision.action === "wait") {
    return waitAndRelease(client, issue, decision.reset!, state.for, clock, log);
  }
  return release(client, issue);
}
