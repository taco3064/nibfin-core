import { childEnvironment } from "../agent/index.ts";
import {
  type CapturedResult,
  type Command,
  describeExit,
  type ProcessRequest,
} from "../agent/process.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type RunTool = (request: ProcessRequest) => Promise<CapturedResult>;

export interface ToolExecutables {
  tar: Command;
  uv: Command;
}

export interface InstallContext {
  fetch: FetchLike;
  run: RunTool;
  executables: ToolExecutables;
  /** `process.arch` of the machine the tools run on. */
  arch: string;
}

/**
 * Runs an install command with the allowlisted Job environment plus `extra`, so
 * stage credentials never reach it. Returns its stdout; a failure throws with its
 * output.
 */
export async function runChecked(
  context: InstallContext,
  command: Command,
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>>,
): Promise<string> {
  const env = childEnvironment(process.env, extra);
  const { status, stdout, stderr } = await context.run({ command, args, cwd, env });
  if (status.exitCode !== 0) {
    const line = [command.command, ...command.args, ...args].join(" ");
    const output = `${stdout}${stderr}`.trim();
    throw new Error(`${line} failed with ${describeExit(status)}: ${output}`);
  }
  return stdout;
}
