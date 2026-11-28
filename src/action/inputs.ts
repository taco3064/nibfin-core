// The Action's inputs (#776). The runner gives each `with:` input as the environment
// variable `INPUT_<NAME>`, upper cased with hyphens kept; the run is described by
// the runner's own `GITHUB_*` variables. This module only reads and checks them.
import type { IssueRef, Repo } from "../github/repo.ts";
import type { WakeInput } from "../route/wake.ts";
import type { RunnerRequestInput } from "../runner-request/answer.ts";
import type { RequestIssue } from "../runner-request/check.ts";
import { positiveInteger, readRepo, required } from "../stages/context.ts";
import { StageError } from "../stages/errors.ts";
import { runUrl } from "../stages/pending.ts";

/** The commands of the Action's `command` input. */
export const actionCommands = ["job-failed", "runner-request", "wake"] as const;
export type ActionCommand = (typeof actionCommands)[number];

/** The environment variable of the Action input `name`. */
export function inputName(name: string): string {
  return `INPUT_${name.toUpperCase()}`;
}

function input(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[inputName(name)];
}

function invalid(field: string, reason: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", `${field} ${reason}`);
}

/** The `command` input; anything else is invalid input, named without its value. */
export function readCommand(env: NodeJS.ProcessEnv): ActionCommand {
  const value = required(input(env, "command"), inputName("command"));
  const command = actionCommands.find((candidate) => candidate === value);
  if (command === undefined) {
    throw invalid(inputName("command"), `must be one of ${actionCommands.join(", ")}`);
  }
  return command;
}

/** What `job-failed` needs. */
export interface JobFailedInputs {
  /** The Nibfin token; only for the GitHub client. */
  token: string;
  issue: IssueRef;
  /** The stage of the Job that failed, as the workflow passed it. */
  stage: string;
  /** This workflow run's URL, as Core's `runUrl` builds it. */
  url: string | undefined;
}

const stagePattern = /^[a-z][a-z-]*$/;

/**
 * The inputs of `job-failed`: `token`, `repo`, `issue` and `stage`, and the run URL
 * from `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`. A missing or invalid field is
 * `STAGE_INPUT_INVALID` naming the field, never its value.
 */
export function readJobFailedInputs(env: NodeJS.ProcessEnv): JobFailedInputs {
  const repo = readRepo(input(env, "repo"), inputName("repo"));
  const number = positiveInteger(input(env, "issue"), inputName("issue"));
  const stage = required(input(env, "stage"), inputName("stage"));
  if (!stagePattern.test(stage)) {
    throw invalid(inputName("stage"), "must be a stage name");
  }
  const runRepo = readRepo(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const runId = positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  return {
    token: required(input(env, "token"), inputName("token")),
    issue: { ...repo, number },
    stage,
    url: runUrl(runRepo, runId),
  };
}

/** What `wake` needs: the event and its repository, and the inputs as given. */
export interface WakeInputs extends WakeInput {
  /** The Nibfin token; empty for a review on a fork pull request, read only to wake. */
  token: string | undefined;
}

function readPayload(text: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid("GITHUB_EVENT_PATH", "must be the event's JSON payload");
  }
  return payload as Record<string, unknown>;
}

/** The run's event: its name, payload and repository, and the run URL. */
interface RunEvent {
  eventName: string;
  payload: Record<string, unknown>;
  repo: Repo;
  url: string | undefined;
}

/**
 * The event from `GITHUB_EVENT_NAME` and the runner's event file
 * (`GITHUB_EVENT_PATH`, read with `readFile`), its repository (`GITHUB_REPOSITORY`)
 * and the run URL. A missing or invalid runner variable or event file is
 * `STAGE_INPUT_INVALID` naming it, never its content.
 */
function readRunEvent(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): RunEvent {
  const eventName = required(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME");
  const path = required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const repo = readRepo(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const runId = positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw invalid("GITHUB_EVENT_PATH", "cannot be read");
  }
  return { eventName, payload: readPayload(text), repo, url: runUrl(repo, runId) };
}

/**
 * The inputs of `wake`: the run's event (`readRunEvent`) and the `token` and
 * `execution-repo` inputs as given: the wake checks them only once it needs them.
 */
export function readWakeInputs(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): WakeInputs {
  const event = readRunEvent(env, readFile);
  return {
    ...event,
    executionRepo: input(env, "execution-repo"),
    token: input(env, "token"),
  };
}

/** What `runner-request` needs: the request as the event gave it, and the tokens. */
export interface RunnerRequestInputs extends RunnerRequestInput {
  /** The Nibfin token; read only once the request passed its body checks. */
  token: string | undefined;
  /** The job's `GITHUB_TOKEN`, which writes the answer as `github-actions[bot]`. */
  jobToken: string;
}

function text(value: unknown, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value === "")) {
    throw invalid("GITHUB_EVENT_PATH", `has no ${field}`);
  }
  return value;
}

/** The request Issue of an `issues` event payload; a missing field is invalid. */
function readRequestIssue(payload: Record<string, unknown>): RequestIssue {
  const issue = Object(payload.issue) as Record<string, unknown>;
  const user = Object(issue.user) as Record<string, unknown>;
  const number = issue.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw invalid("GITHUB_EVENT_PATH", "has no issue.number");
  }
  return {
    number,
    title: text(issue.title, "issue.title", true),
    // GitHub sends `null` for an Issue without a body.
    body: issue.body === null ? "" : text(issue.body, "issue.body", true),
    login: text(user.login, "issue.user.login"),
    userType: text(user.type, "issue.user.type"),
  };
}

/**
 * The inputs of `runner-request`: the run's event, which must be `issues`, with the
 * request Issue's number, title, body and author (login and type) from its payload,
 * the `job-token` input (required) and the `token` input as given.
 */
export function readRunnerRequestInputs(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): RunnerRequestInputs {
  const jobToken = required(input(env, "job-token"), inputName("job-token"));
  const event = readRunEvent(env, readFile);
  if (event.eventName !== "issues") {
    throw invalid("GITHUB_EVENT_NAME", "must be issues");
  }
  return {
    repo: event.repo,
    issue: readRequestIssue(event.payload),
    url: event.url,
    token: input(env, "token"),
    jobToken,
  };
}
