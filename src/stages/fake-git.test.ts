// Shared test support: real Git repositories under the ignored `.test-tmp/`, with a
// local bare repository as the remote. It holds no tests of its own.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { fakeToken } from "../github/fake-github.test.ts";
import {
  Git,
  type GitCall,
  type GitOutput,
  type GitRunner,
  runGitProcess,
} from "./git.ts";

const identity = {
  GIT_AUTHOR_NAME: "Nibfin Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Nibfin Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** Runs Git in `cwd` for the test itself and returns its trimmed output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Writes `file` and commits it; returns the new commit. */
export function commitFile(cwd: string, file: string, text: string, message: string) {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

export interface GitFixture {
  root: string;
  /** The bare repository standing in for GitHub. */
  remote: string;
  /** A clone of the remote with `main` checked out, like the Job's workspace. */
  workspace: string;
  /** Another clone, for commits that someone else pushes. */
  other: string;
  /** The remote's head of `branch`, if it exists. */
  remoteHead(branch: string): string | undefined;
}

/** A bare remote with one commit on `main`, and clones of it. */
export async function makeGitFixture(prefix: string): Promise<GitFixture> {
  const root = await makeTempDir(prefix);
  const remote = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = join(root, "seed");
  git(root, "init", "--quiet", "--initial-branch=main", seed);
  commitFile(seed, "README.md", "seed\n", "init");
  git(seed, "push", "--quiet", remote, "main");
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  git(root, "clone", "--quiet", remote, workspace);
  git(root, "clone", "--quiet", remote, other);
  return {
    root,
    remote,
    workspace,
    other,
    remoteHead: (branch) => {
      try {
        return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      } catch {
        return undefined;
      }
    },
  };
}

/** Every Git call with its arguments and the environment it got. */
export interface GitRecorder {
  run: GitRunner;
  calls: GitCall[];
  outputs: GitOutput[];
}

/**
 * Real Git that records each call. `override` may answer a call instead, for outputs
 * real Git cannot produce here (such as GitHub's rejection messages).
 */
export function recordingGit(
  override?: (call: GitCall) => GitOutput | undefined,
): GitRecorder {
  const recorder: GitRecorder = {
    calls: [],
    outputs: [],
    run: async (call) => {
      recorder.calls.push(call);
      const output = override?.(call) ?? (await runGitProcess(call));
      recorder.outputs.push(output);
      return output;
    },
  };
  return recorder;
}

/** A `Git` on `workspace` that pushes to the local `remote`. */
export function fixtureGit(fixture: GitFixture, run: GitRunner = runGitProcess): Git {
  return new Git({
    workspace: fixture.workspace,
    remoteUrl: fixture.remote,
    token: fakeToken,
    run,
  });
}
