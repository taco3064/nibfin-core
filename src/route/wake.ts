// The wake: turns one GitHub event of a repository into a route run of the
// execution repository's nibfin-shared-runner.yml. Events only wake an Issue; the
// route decides what runs (R4.35). The Action's `wake` command runs it (#776).
import type { ActingClient } from "../github/client.ts";
import { hasWritePermission } from "../github/pull-request.ts";
import { formatIssue, type Repo } from "../github/repo.ts";
import { readRepo } from "../stages/context.ts";
import { StageError } from "../stages/errors.ts";
import { askPersonOnce, describeFailure } from "../stages/pending.ts";
import { dispatchRoute } from "./dispatch.ts";
import { routeEvent, type RouteTarget } from "./event-issues.ts";

interface Named {
  name?: string;
}

interface FullName {
  full_name?: string;
}

/** The fields of a GitHub event payload the wake reads; all others are ignored. */
export interface WakePayload {
  action?: string;
  sender?: { login?: string };
  repository?: { default_branch?: string };
  issue?: { number?: number; state?: string; labels?: Named[] };
  label?: Named;
  pull_request?: { head?: { ref?: string; repo?: FullName | null } };
  workflow_run?: {
    event?: string;
    head_branch?: string | null;
    head_sha?: string;
    head_repository?: FullName | null;
  };
  check_suite?: { app?: { slug?: string } | null; head_branch?: string | null };
  sha?: string;
  ref?: string;
  after?: string;
}

/**
 * What an event asks for: nothing (`skip`, with the log line saying why), or a route
 * run of `target` dispatched to `executionRepo`, after `writer` (when set) is found
 * to have admin or write permission.
 */
export type WakeDecision =
  | { kind: "skip"; reason: string }
  | {
      kind: "wake";
      executionRepo: Repo;
      target: RouteTarget;
      writer: string | undefined;
    };

const issueBranchPrefix = "nibfin/issue-";
/**
 * Labels Nibfin's own stages add and remove; their changes wake nothing, except
 * `delivered` added to an Issue that is not open (`deliveredByHand`).
 */
const ownLabels: ReadonlySet<string> = new Set(["shaped", "delivered"]);

function invalidEvent(eventName: string, field: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", `The ${eventName} event has no ${field}`);
}

/** The execution repository, required before any target or token is used. */
function executionRepoOf(value: string | undefined): Repo {
  if (value === undefined || value.trim() === "") {
    throw new StageError(
      "STAGE_INPUT_INVALID",
      "The variable NIBFIN_EXECUTION_REPO is not set (input execution-repo)",
    );
  }
  return readRepo(value, "NIBFIN_EXECUTION_REPO");
}

const skip = (reason: string): WakeDecision => ({ kind: "skip", reason });

/**
 * Whether the event adds `delivered` to an Issue that is not open: a person closed
 * it first and marked it delivered afterwards, so the route's wake-only redo has to
 * run. Nibfin's own close adds the label while the Issue is still open. A payload
 * without the state also wakes; the route decides from GitHub, and an extra wake
 * does no repeated work (R4.35).
 */
function deliveredByHand(payload: WakePayload, label: string): boolean {
  return (
    payload.action === "labeled" &&
    label === "delivered" &&
    payload.issue?.state !== "open"
  );
}

function issuesWake(
  payload: WakePayload,
  name: string,
  executionRepo: Repo,
): WakeDecision {
  const number = payload.issue?.number;
  if (number === undefined) {
    throw invalidEvent("issues", "issue");
  }
  const labels = (payload.issue?.labels ?? []).map((label) => label.name);
  if (!labels.includes("scope") && !labels.includes("request")) {
    return skip(`${name}#${number} has no scope or request label; not routed`);
  }
  const { action } = payload;
  const label = payload.label?.name;
  if (
    (action === "labeled" || action === "unlabeled") &&
    label !== undefined &&
    ownLabels.has(label) &&
    !deliveredByHand(payload, label)
  ) {
    return skip(`Nibfin's own label change (${action} ${label}); not routed`);
  }
  const writer = payload.sender?.login;
  if (writer === undefined) {
    throw invalidEvent("issues", "sender");
  }
  const target = { issue: number };
  return { kind: "wake", executionRepo, target, writer };
}

function reviewWake(
  payload: WakePayload,
  name: string,
  executionRepo: string | undefined,
): WakeDecision {
  const head = payload.pull_request?.head;
  const branch = head?.ref;
  if (branch === undefined || !branch.startsWith(issueBranchPrefix)) {
    return skip("A review on a pull request that is not Nibfin's; not routed");
  }
  const headRepo = head?.repo?.full_name;
  if (headRepo !== name) {
    const from = headRepo ?? "an unknown repository";
    return skip(`A review on a pull request from ${from}; not routed`);
  }
  const repo = executionRepoOf(executionRepo);
  const writer = payload.sender?.login;
  if (writer === undefined) {
    throw invalidEvent("pull_request_review", "sender");
  }
  return { kind: "wake", executionRepo: repo, target: { branch }, writer };
}

function workflowRunTarget(payload: WakePayload, name: string): RouteTarget | string {
  const run = payload.workflow_run;
  if (run?.event === "pull_request") {
    const branch = run.head_branch;
    if (typeof branch !== "string" || !branch.startsWith(issueBranchPrefix)) {
      return "A run of a pull request that is not Nibfin's; not routed";
    }
    const headRepo = run.head_repository?.full_name;
    if (headRepo !== name) {
      return `A pull request from ${headRepo ?? "an unknown repository"}; not routed`;
    }
    return { branch };
  }
  const sha = run?.head_sha;
  if (sha === undefined) {
    throw invalidEvent("workflow_run", "head_sha");
  }
  return { sha };
}

function checkSuiteTarget(payload: WakePayload): RouteTarget | string {
  const suite = payload.check_suite;
  const branch = suite?.head_branch;
  if (suite?.app?.slug === "github-actions" || typeof branch !== "string" || !branch) {
    return "A check suite of GitHub Actions or of no branch; not routed";
  }
  return { branch };
}

function pushTarget(payload: WakePayload): RouteTarget | string {
  const branch = payload.repository?.default_branch;
  if (branch === undefined || payload.ref !== `refs/heads/${branch}`) {
    return "A push to a branch that is not the default branch; not routed";
  }
  if (payload.after === undefined) {
    throw invalidEvent("push", "after");
  }
  return { sha: payload.after };
}

/** The target of an event that wakes without a permission check, or why it skips. */
function targetOf(
  eventName: string,
  payload: WakePayload,
  name: string,
): RouteTarget | string {
  switch (eventName) {
    case "workflow_run":
      return workflowRunTarget(payload, name);
    case "check_suite":
      return checkSuiteTarget(payload);
    case "status":
      if (payload.sha === undefined) {
        throw invalidEvent("status", "sha");
      }
      return { sha: payload.sha };
    case "push":
      return pushTarget(payload);
    default:
      return `The ${eventName} event is not routed`;
  }
}

/**
 * What an event of `repo` wakes, decided from its payload alone, before any token is
 * used, with the workflows' rules in their order:
 *
 * - every event but `pull_request_review` first needs the execution repository;
 * - `issues`: the Issue needs `scope` or `request`, and a `labeled` or `unlabeled`
 *   `shaped` or `delivered` wakes nothing, except `labeled delivered` on an Issue
 *   whose state is not `open` (delivered by hand after the close); then
 *   `{ issue }`, if the sender writes;
 * - `pull_request_review`: a `nibfin/issue-*` head of the same repository, then the
 *   execution repository; `{ branch }`, if the sender writes;
 * - `workflow_run`: of a `pull_request`, a `nibfin/issue-*` head of the same
 *   repository, `{ branch }` (a failed check is never routed by commit); any other,
 *   `{ sha: head_sha }`;
 * - `check_suite`: not of the `github-actions` app and with a head branch,
 *   `{ branch }`;
 * - `status`: `{ sha }`; `push`: only to the default branch, `{ sha: after }`;
 * - any other event is not routed.
 *
 * A missing or invalid `NIBFIN_EXECUTION_REPO`, or a payload without a field its event
 * always has, is `STAGE_INPUT_INVALID`.
 */
export function wakeOf(
  eventName: string,
  payload: WakePayload,
  repo: Repo,
  executionRepo: string | undefined,
): WakeDecision {
  const name = `${repo.owner}/${repo.repo}`;
  if (eventName === "pull_request_review") {
    return reviewWake(payload, name, executionRepo);
  }
  const execution = executionRepoOf(executionRepo);
  if (eventName === "issues") {
    return issuesWake(payload, name, execution);
  }
  const target = targetOf(eventName, payload, name);
  return typeof target === "string"
    ? skip(target)
    : { kind: "wake", executionRepo: execution, target, writer: undefined };
}

/** What `runWake` reads: the event, its repository and this run's URL. */
export interface WakeInput {
  eventName: string;
  payload: WakePayload;
  repo: Repo;
  /** The `NIBFIN_EXECUTION_REPO` variable as the workflow passed it. */
  executionRepo: string | undefined;
  url: string | undefined;
}

/**
 * After a failed wake, asks a person once on each Issue of the target (`routeEvent`)
 * with the failure itself (`askPersonOnce`): an Issue whose `pending` stands is left
 * as it is. Nothing is written when the target belongs to no Issue or its Issues
 * cannot be read.
 */
async function askPeople(
  client: ActingClient,
  input: WakeInput,
  target: RouteTarget,
  error: unknown,
  log: (line: string) => void,
): Promise<void> {
  let issues: number[];
  try {
    issues = await routeEvent(client, input.repo, target);
  } catch (readError) {
    const reason = describeFailure(readError);
    log(`The wake failed and its Issues could not be read (${reason}); no pending added`);
    return;
  }
  if (issues.length === 0) {
    log("The wake failed and belongs to no Issue; no pending added");
  }
  for (const number of issues) {
    const issue = { ...input.repo, number };
    const name = formatIssue(issue);
    try {
      const wrote = await askPersonOnce(client, issue, error, input.url);
      log(
        wrote
          ? `Added pending to ${name}`
          : `${name}: Nibfin's stop stands; left as it is`,
      );
    } catch (writeError) {
      log(`Could not add pending to ${name}: ${describeFailure(writeError)}`);
    }
  }
}

/**
 * Wakes the event's Issue (`wakeOf`): a skipped event logs why and never connects.
 * Otherwise it connects, checks the writer's permission (`hasWritePermission`; without
 * it nothing is routed) and dispatches the route run (`dispatchRoute`). When that
 * fails, each Issue of the target is asked about once (`askPersonOnce`) and the failure
 * is thrown on, so the run fails.
 */
export async function runWake(
  input: WakeInput,
  connect: () => Promise<ActingClient>,
  log: (line: string) => void,
): Promise<void> {
  const decision = wakeOf(
    input.eventName,
    input.payload,
    input.repo,
    input.executionRepo,
  );
  if (decision.kind === "skip") {
    log(decision.reason);
    return;
  }
  const client = await connect();
  const { target, writer } = decision;
  try {
    if (writer !== undefined && !(await hasWritePermission(client, input.repo, writer))) {
      log(`${writer} has no admin or write permission; not routed`);
      return;
    }
    const scope = { client, runRepo: decision.executionRepo, runId: undefined, log };
    await dispatchRoute(scope, input.repo, target);
  } catch (error) {
    await askPeople(client, input, target, error, log);
    throw error;
  }
}
