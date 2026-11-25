import { isAbsolute, relative, resolve } from "node:path";
import { type Provider, providers } from "../agent/index.ts";
import type { Repo } from "../github/index.ts";
import { StageError } from "./errors.ts";
import { parseMemory } from "./host-memory.ts";

/** The fix reasons of a Deliver run. */
export const fixReasons = ["ci-failure", "review", "cd-failure", "conflict"] as const;
export type FixReason = (typeof fixReasons)[number];

/** What one Job runs on; supplied by the caller (#674). */
export interface JobContext {
  repo: Repo;
  issue: number;
  /** From the Pool or runner configuration, never from a workflow or dispatch input. */
  provider: Provider;
  model?: string;
  /** Only for the GitHub client and Core's Git remote calls; never given to an agent. */
  token: string;
  /** The agent CLI's config home on the login volume. */
  agentHome: string;
  /** A checkout of the base branch, made without persisted credentials. */
  workspace: string;
  /** Holds the `.nibfin.json` tools; outside the workspace. */
  toolCache: string;
  /** Why a Deliver run is a fix run; only with `--stage deliver`. */
  reason?: FixReason;
  /** The repository whose workflow runs this Job (#674), from `NIBFIN_RUN_REPO`. */
  runRepo?: Repo;
  /** This Job's workflow run id, from `NIBFIN_RUN_ID`. */
  runId?: number;
  /** Where the stage writes its next action, from `NIBFIN_NEXT_FILE`. */
  nextFile?: string;
  /** Bytes the host must have available before the first agent run. */
  memoryRequired?: number;
}

/** The options `nibfin run` takes, each as `--<name> <value>`. */
export const jobOptions = [
  "stage",
  "repo",
  "issue",
  "provider",
  "model",
  "reason",
] as const;
type JobOption = (typeof jobOptions)[number];
type JobOptions = Partial<Record<JobOption, string>>;

function invalid(field: string, reason: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", `${field} ${reason}`);
}

/** Parses `--<name> <value>` pairs; anything else is invalid input. */
export function parseJobOptions(args: readonly string[]): JobOptions {
  const options: JobOptions = {};
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

export function required(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw invalid(field, "is missing");
  }
  return value;
}

export function positiveInteger(value: string | undefined, field: string): number {
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

export function readRepo(value: string | undefined, field: string): Repo {
  const match = repoPattern.exec(required(value, field));
  if (match === null) {
    throw invalid(field, "must be <owner>/<repo>");
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

function readReason(options: JobOptions): FixReason {
  if (options.stage !== "deliver") {
    throw invalid("--reason", "is only valid with --stage deliver");
  }
  const reason = fixReasons.find((candidate) => candidate === options.reason);
  if (reason === undefined) {
    throw invalid("--reason", `must be one of ${fixReasons.join(", ")}`);
  }
  return reason;
}

/** An absolute path outside the workspace, so no agent can read or write it. */
function readNextFile(value: string, workspace: string): string {
  const path = absolutePath(value, "NIBFIN_NEXT_FILE");
  const inside = relative(resolve(workspace), resolve(path));
  if (!inside.startsWith("..") && !isAbsolute(inside)) {
    throw invalid("NIBFIN_NEXT_FILE", "must be outside NIBFIN_WORKSPACE");
  }
  return path;
}

/** The optional fields; each is checked only when it is set. */
function optionalFields(
  options: JobOptions,
  env: NodeJS.ProcessEnv,
  workspace: string,
): Partial<JobContext> {
  const fields: Partial<JobContext> = {};
  if (options.model !== undefined) {
    fields.model = required(options.model, "--model");
  }
  if (options.reason !== undefined) {
    fields.reason = readReason(options);
  }
  if (env.NIBFIN_RUN_REPO !== undefined) {
    fields.runRepo = readRepo(env.NIBFIN_RUN_REPO, "NIBFIN_RUN_REPO");
  }
  if (env.NIBFIN_RUN_ID !== undefined) {
    fields.runId = positiveInteger(env.NIBFIN_RUN_ID, "NIBFIN_RUN_ID");
  }
  if (env.NIBFIN_NEXT_FILE !== undefined) {
    fields.nextFile = readNextFile(env.NIBFIN_NEXT_FILE, workspace);
  }
  if (env.NIBFIN_MEMORY_REQUIRED !== undefined) {
    const bytes = parseMemory(env.NIBFIN_MEMORY_REQUIRED);
    if (bytes === undefined) {
      throw invalid("NIBFIN_MEMORY_REQUIRED", "must be a number with b, k, m or g");
    }
    fields.memoryRequired = bytes;
  }
  return fields;
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
    repo: readRepo(options.repo, "--repo"),
    issue: positiveInteger(options.issue, "--issue"),
    provider: readProvider(options.provider),
    token: required(env.NIBFIN_GITHUB_TOKEN, "NIBFIN_GITHUB_TOKEN"),
    agentHome: absolutePath(env.NIBFIN_AGENT_HOME, "NIBFIN_AGENT_HOME"),
    workspace: absolutePath(env.NIBFIN_WORKSPACE, "NIBFIN_WORKSPACE"),
    toolCache: absolutePath(env.NIBFIN_TOOL_CACHE, "NIBFIN_TOOL_CACHE"),
  };
  return { ...context, ...optionalFields(options, env, context.workspace) };
}
