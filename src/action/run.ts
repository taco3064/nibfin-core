// The Action's commands (#776). Rules live in their Core modules; this file only
// connects them to the inputs and the log.
import { readFileSync } from "node:fs";
import {
  type ActingClient,
  connectAs,
  connectClient,
  type LogLine,
} from "../github/client.ts";
import { formatIssue } from "../github/repo.ts";
import { runWake } from "../route/wake.ts";
import { type Age, createAge } from "../runner-request/age.ts";
import { answerRequest } from "../runner-request/answer.ts";
import { required } from "../stages/context.ts";
import { askPersonOnce, describeFailure, JobFailedError } from "../stages/pending.ts";
import {
  type ActionCommand,
  inputName,
  readCommand,
  readJobFailedInputs,
  readRunnerRequestInputs,
  readWakeInputs,
} from "./inputs.ts";

/** The account a job's `GITHUB_TOKEN` writes as; gh-nibfin takes answers only from it. */
export const jobTokenLogin = "github-actions[bot]";

export interface OutputStream {
  write(text: string): unknown;
}

export interface ActionIo {
  stdout: OutputStream;
  stderr: OutputStream;
}

/** What the Action uses; tests replace them. */
export interface ActionDeps {
  env: NodeJS.ProcessEnv;
  connect: (token: string, log: LogLine) => Promise<ActingClient>;
  /** A client for a job's `GITHUB_TOKEN`, writing as `jobTokenLogin`. */
  connectJob: (token: string, log: LogLine) => Promise<ActingClient>;
  /** Reads the runner's event file. */
  readFile: (path: string) => string;
  /** `age`, run with only `PATH` from `env`. */
  age: (env: NodeJS.ProcessEnv) => Age;
}

export const defaultActionDeps: ActionDeps = {
  env: process.env,
  connect: (token, log) => connectClient(token, {}, log),
  connectJob: (token, log) => connectAs(token, jobTokenLogin, {}, log),
  readFile: (path) => readFileSync(path, "utf8"),
  age: (env) => createAge(env),
};

type Command = (io: ActionIo, deps: ActionDeps) => Promise<number>;

const lineLog = (io: ActionIo) => (line: string) => void io.stdout.write(`${line}\n`);

/**
 * `job-failed`: the last step of a route, finish or stage Job that failed. It adds
 * `pending` with `JOB_FAILED` unless Core already reported for the Issue
 * (`askPersonOnce`).
 */
async function jobFailed(io: ActionIo, deps: ActionDeps): Promise<number> {
  const inputs = readJobFailedInputs(deps.env);
  const client = await deps.connect(inputs.token, lineLog(io));
  const { issue, stage, url } = inputs;
  const wrote = await askPersonOnce(client, issue, new JobFailedError(stage), url, stage);
  const name = formatIssue(issue);
  io.stdout.write(
    wrote
      ? `Added pending to ${name}\n`
      : `${name}: Nibfin's stop stands; left as it is\n`,
  );
  return 0;
}

/**
 * `wake`: the job of `nibfin-events.yml` and of the user `nibfin-issue.yml`. It runs
 * `runWake`; the `token` input is required only once an event wakes an Issue.
 */
async function wake(io: ActionIo, deps: ActionDeps): Promise<number> {
  const { token, ...input } = readWakeInputs(deps.env, deps.readFile);
  const log = lineLog(io);
  const connect = () => deps.connect(required(token, inputName("token")), log);
  await runWake(input, connect, log);
  return 0;
}

/**
 * `runner-request`: the step of `nibfin-runner-request.yml`. It answers the request
 * (`answerRequest`) with a client for `job-token` that writes as
 * `github-actions[bot]`; the `token` input is required only once the request passed
 * its body checks.
 */
async function runnerRequest(io: ActionIo, deps: ActionDeps): Promise<number> {
  const { token, jobToken, ...input } = readRunnerRequestInputs(deps.env, deps.readFile);
  const log = lineLog(io);
  const job = await deps.connectJob(jobToken, log);
  const connect = () => deps.connect(required(token, inputName("token")), log);
  await answerRequest(input, { job, connect, age: deps.age(deps.env), log });
  return 0;
}

const commands: Record<ActionCommand, Command> = {
  "job-failed": jobFailed,
  "runner-request": runnerRequest,
  wake,
};

/**
 * Runs the command the `command` input names and returns the exit code: 0 when it
 * did its work, 1 with the failure on stderr (its code and message, never an input's
 * value).
 */
export async function runAction(io: ActionIo, deps: ActionDeps): Promise<number> {
  try {
    return await commands[readCommand(deps.env)](io, deps);
  } catch (error) {
    io.stderr.write(`nibfin: ${describeFailure(error)}\n`);
    return 1;
  }
}
