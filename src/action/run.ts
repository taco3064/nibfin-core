// The Action's commands (#776). Rules live in their Core modules; this file only
// connects them to the inputs and the log.
import { type ActingClient, connectClient, type LogLine } from "../github/client.ts";
import { formatIssue } from "../github/repo.ts";
import { askPersonOnce, describeFailure, JobFailedError } from "../stages/pending.ts";
import { type ActionCommand, readCommand, readJobFailedInputs } from "./inputs.ts";

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
}

export const defaultActionDeps: ActionDeps = {
  env: process.env,
  connect: (token, log) => connectClient(token, {}, log),
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

const commands: Record<ActionCommand, Command> = { "job-failed": jobFailed };

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
