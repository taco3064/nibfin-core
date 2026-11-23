import { isAbsolute } from "node:path";
import { type Provider, providers } from "../agent/index.ts";
import type { Actor, Repo } from "../github/index.ts";
import { StageError } from "./errors.ts";

/** What one Job runs on; supplied by the caller (#674). */
export interface JobContext {
  repo: Repo;
  issue: number;
  /** From the Pool or runner configuration, never from a workflow or dispatch input. */
  provider: Provider;
  model?: string;
  /** Used only for the GitHub client; never printed or passed to an agent. */
  token: string;
  actor: Actor;
  /** The agent CLI's config home on the login volume. */
  agentHome: string;
  /** A checkout of the base branch, made without persisted credentials. */
  workspace: string;
  /** Holds the `.nibfin.json` tools; outside the workspace. */
  toolCache: string;
}

/** The options `nibfin run` takes, each as `--<name> <value>`. */
export const jobOptions = ["stage", "repo", "issue", "provider", "model"] as const;
type JobOption = (typeof jobOptions)[number];

function invalid(field: string, reason: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", `${field} ${reason}`);
}

/** Parses `--<name> <value>` pairs; anything else is invalid input. */
export function parseJobOptions(
  args: readonly string[],
): Partial<Record<JobOption, string>> {
  const options: Partial<Record<JobOption, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = jobOptions.find((option) => flag === `--${option}`);
    if (name === undefined) {
      throw invalid(JSON.stringify(flag), "is not a known option");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw invalid(flag, "needs a value");
    }
    if (Object.hasOwn(options, name)) {
      throw invalid(flag, "is given more than once");
    }
    options[name] = value;
  }
  return options;
}

const repoPattern = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const numberPattern = /^[1-9]\d*$/;

function required(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw invalid(field, "is missing");
  }
  return value;
}

function positiveInteger(value: string | undefined, field: string): number {
  const text = required(value, field);
  const number = Number(text);
  if (!numberPattern.test(text) || !Number.isSafeInteger(number)) {
    throw invalid(field, "must be a positive integer");
  }
  return number;
}

function absolutePath(value: string | undefined, field: string): string {
  const path = required(value, field);
  if (!isAbsolute(path)) {
    throw invalid(field, "must be an absolute path");
  }
  return path;
}

function readRepo(value: string | undefined): Repo {
  const match = repoPattern.exec(required(value, "--repo"));
  if (match === null) {
    throw invalid("--repo", "must be <owner>/<repo>");
  }
  return { owner: match[1], repo: match[2] };
}

function readProvider(value: string | undefined): Provider {
  const name = required(value, "--provider");
  const provider = providers.find((candidate) => candidate === name);
  if (provider === undefined) {
    throw invalid("--provider", `must be one of ${providers.join(", ")}`);
  }
  return provider;
}

/**
 * The Job context from `nibfin run` options and the environment. A missing or invalid
 * field is `STAGE_INPUT_INVALID` naming the field, never its value.
 */
export function readJobContext(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): JobContext {
  const options = parseJobOptions(args);
  const context: JobContext = {
    repo: readRepo(options.repo),
    issue: positiveInteger(options.issue, "--issue"),
    provider: readProvider(options.provider),
    token: required(env.NIBFIN_GITHUB_TOKEN, "NIBFIN_GITHUB_TOKEN"),
    actor: {
      id: positiveInteger(env.NIBFIN_ACTOR_ID, "NIBFIN_ACTOR_ID"),
      login: required(env.NIBFIN_ACTOR_LOGIN, "NIBFIN_ACTOR_LOGIN"),
    },
    agentHome: absolutePath(env.NIBFIN_AGENT_HOME, "NIBFIN_AGENT_HOME"),
    workspace: absolutePath(env.NIBFIN_WORKSPACE, "NIBFIN_WORKSPACE"),
    toolCache: absolutePath(env.NIBFIN_TOOL_CACHE, "NIBFIN_TOOL_CACHE"),
  };
  if (options.model !== undefined) {
    context.model = required(options.model, "--model");
  }
  return context;
}
