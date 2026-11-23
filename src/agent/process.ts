import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { pipeline, Readable } from "node:stream";

/** An executable and the arguments that always precede the caller's arguments. */
export interface Command {
  command: string;
  args: readonly string[];
}

export interface ExitStatus {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ByteSink {
  write(chunk: Uint8Array | string): unknown;
}

export interface ProcessRequest {
  command: Command;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface StreamingRequest extends ProcessRequest {
  stdin: string;
  stdout: ByteSink;
  stderr: ByteSink;
  onLine(line: string): void;
}

export interface CapturedResult {
  status: ExitStatus;
  stdout: string;
  stderr: string;
}

export function describeExit(status: ExitStatus): string {
  return status.exitCode === null
    ? `signal ${status.signal}`
    : `exit code ${status.exitCode}`;
}

function start(request: ProcessRequest, stdio: StdioOptions): ChildProcess {
  return spawn(request.command.command, [...request.command.args, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio,
  });
}

function waitForExit(child: ChildProcess): Promise<ExitStatus> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      resolve({ exitCode, signal });
    });
  });
}

/**
 * Feeds `stdin` to the process, forwards its output unchanged and reports each
 * stdout line to `onLine`.
 */
export function runStreaming(request: StreamingRequest): Promise<ExitStatus> {
  const child = start(request, "pipe");
  const exit = waitForExit(child);
  // A CLI that stops reading its prompt reports that through its exit status.
  pipeline(Readable.from([request.stdin]), child.stdin!, () => undefined);
  child.stdout!.on("data", (chunk: Buffer) => request.stdout.write(chunk));
  child.stderr!.on("data", (chunk: Buffer) => request.stderr.write(chunk));
  createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
    request.onLine(line);
  });
  return exit;
}

export async function runCaptured(request: ProcessRequest): Promise<CapturedResult> {
  const child = start(request, ["ignore", "pipe", "pipe"]);
  const exit = waitForExit(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const status = await exit;
  return { status, stdout, stderr };
}

/** Runs the process for its exit status only; its output is discarded. */
export function runQuiet(request: ProcessRequest): Promise<ExitStatus> {
  return waitForExit(start(request, "ignore"));
}
