import { childEnvironment } from "../agent/index.ts";
import { runCaptured } from "../agent/process.ts";
import { StageError } from "./errors.ts";

/** The committed head and the worktree changes, untracked files included. */
export interface WorkspaceState {
  head: string;
  status: string;
}

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
  const status = await git(workspace, ["status", "--porcelain", "--untracked-files=all"]);
  return { head, status };
}

/**
 * Fails with `STAGE_WORKSPACE_MODIFIED` unless the workspace is clean and, when
 * `before` is given, still at the same `HEAD`.
 */
export function requireUnchanged(
  state: WorkspaceState,
  role: string,
  before?: WorkspaceState,
): void {
  const when = before === undefined ? "before" : "after";
  if (before !== undefined && state.head !== before.head) {
    const message = `${role} moved HEAD from ${before.head} to ${state.head}`;
    throw new StageError("STAGE_WORKSPACE_MODIFIED", message);
  }
  if (state.status !== "") {
    const message = `The workspace has changes ${when} ${role}:\n${state.status}`;
    throw new StageError("STAGE_WORKSPACE_MODIFIED", message);
  }
}
