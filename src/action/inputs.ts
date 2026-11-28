// The Action's inputs (#776). The runner gives each `with:` input as the environment
// variable `INPUT_<NAME>`, upper cased with hyphens kept; the run is described by
// the runner's own `GITHUB_*` variables. This module only reads and checks them.
import type { IssueRef } from "../github/repo.ts";
import { positiveInteger, readRepo, required } from "../stages/context.ts";
import { StageError } from "../stages/errors.ts";
import { runUrl } from "../stages/pending.ts";

/** The commands of the Action's `command` input. */
export const actionCommands = ["job-failed"] as const;
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
