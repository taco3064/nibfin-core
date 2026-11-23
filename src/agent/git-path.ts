import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolves `git rev-parse --git-path <name>` to an absolute path. */
export async function gitPath(workspace: string, name: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", name], {
    cwd: workspace,
  });
  return resolve(workspace, stdout.replace(/\r?\n$/, ""));
}
