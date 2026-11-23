import { childEnvironment } from "../agent/index.ts";
import { runCaptured } from "../agent/process.ts";
import { StageError } from "./errors.ts";

/**
 * The committed head and every worktree entry Git reports: changes, untracked files
 * and ignored files (`.gitignore` and `info/exclude`), each file listed on its own.
 */
export interface WorkspaceState {
  head: string;
  /** Lines of `git status --porcelain --ignored --untracked-files=all`. */
  entries: string[];
}

const ignoredPrefix = "!! ";

async function git(workspace: string, args: readonly string[]): Promise<string> {
  const { status, stdout, stderr } = await runCaptured({
    command: { command: "git", args: [] },
    args,
    cwd: workspace,
    env: childEnvironment(process.env, {}),
  });
  if (status.exitCode !== 0) {
    const message = `NIBFIN_WORKSPACE is not a usable Git checkout: ${stderr.trim()}`;
    throw new StageError("STAGE_INPUT_INVALID", message);
  }
  return stdout;
}

export async function readWorkspaceState(workspace: string): Promise<WorkspaceState> {
  const head = (await git(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
  const status = await git(workspace, [
    "status",
    "--porcelain",
    "--ignored",
    "--untracked-files=all",
  ]);
  const entries = status.split("\n").filter((line) => line !== "");
  return { head, entries };
}

function modified(message: string): StageError {
  return new StageError("STAGE_WORKSPACE_MODIFIED", message);
}

/** Fails on any change or untracked file; ignored files may exist. */
export function requireClean(state: WorkspaceState, role: string): void {
  const changes = state.entries.filter((entry) => !entry.startsWith(ignoredPrefix));
  if (changes.length > 0) {
    throw modified(`The workspace has changes before ${role}:\n${changes.join("\n")}`);
  }
}

/**
 * Fails unless `after` is at the same `HEAD` and lists exactly the entries of `before`,
 * ignored files included. The message lists added (`+`) and removed (`-`) entries.
 */
export function requireSame(
  before: WorkspaceState,
  after: WorkspaceState,
  role: string,
): void {
  if (after.head !== before.head) {
    throw modified(`${role} moved HEAD from ${before.head} to ${after.head}`);
  }
  const added = after.entries.filter((entry) => !before.entries.includes(entry));
  const removed = before.entries.filter((entry) => !after.entries.includes(entry));
  const lines = [
    ...added.map((entry) => `+ ${entry}`),
    ...removed.map((entry) => `- ${entry}`),
  ];
  if (lines.length > 0) {
    throw modified(`${role} changed the workspace:\n${lines.join("\n")}`);
  }
}
