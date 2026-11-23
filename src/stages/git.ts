import { devNull } from "node:os";
import { resolve } from "node:path";
import { childEnvironment } from "../agent/index.ts";
import { runCaptured } from "../agent/process.ts";
import type { Actor, Repo } from "../github/index.ts";
import { StageError } from "./errors.ts";

/** One Git child process. */
export interface GitCall {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface GitOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one Git process; tests wrap it to record the calls. */
export type GitRunner = (call: GitCall) => Promise<GitOutput>;

export const runGitProcess: GitRunner = async (call) => {
  const { status, stdout, stderr } = await runCaptured({
    command: { command: "git", args: [] },
    args: call.args,
    cwd: call.cwd,
    env: call.env,
  });
  return { exitCode: status.exitCode, stdout, stderr };
};

/** The URL Core fetches from and pushes to. */
export function githubRemoteUrl(repo: Repo): string {
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

/**
 * Settings for the calls that reach the remote: no hooks, credential helpers, askpass
 * programs or signing commands from the workspace's config run while the token is
 * in the environment, and only the remote URL's protocol is allowed.
 */
const remoteArgs = [
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "credential.helper=",
  "-c",
  "push.gpgSign=false",
];

/** The Git commands Core runs in the workspace. The token reaches remote calls only. */
export class Git {
  readonly workspace: string;
  readonly remoteUrl: string;
  readonly #token: string;
  readonly #run: GitRunner;

  constructor(options: {
    workspace: string;
    remoteUrl: string;
    token: string;
    run: GitRunner;
  }) {
    this.workspace = options.workspace;
    this.remoteUrl = options.remoteUrl;
    this.#token = options.token;
    this.#run = options.run;
  }

  /** The `Authorization` header Git sends to github.com, as actions/checkout does. */
  #header(): string {
    const basic = Buffer.from(`x-access-token:${this.#token}`).toString("base64");
    return `AUTHORIZATION: basic ${basic}`;
  }

  /** `text` without the token or the header that carries it. */
  redact(text: string): string {
    const basic = this.#header().slice("AUTHORIZATION: basic ".length);
    return text.split(this.#token).join("***").split(basic).join("***");
  }

  #allowedProtocol(): string {
    return /^https:\/\//.test(this.remoteUrl) ? "https" : "file";
  }

  async #call(args: readonly string[], extra: Record<string, string>) {
    const env = childEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0", ...extra });
    const output = await this.#run({ args, cwd: this.workspace, env });
    return {
      exitCode: output.exitCode,
      stdout: this.redact(output.stdout),
      stderr: this.redact(output.stderr),
    };
  }

  /** A local command; fails with `STAGE_GIT_FAILED` unless it exits 0. */
  async run(args: readonly string[]): Promise<string> {
    return required(args, await this.#call(args, {}));
  }

  /** A local command whose failure is an answer, such as a missing ref. */
  async probe(args: readonly string[]): Promise<GitOutput> {
    return this.#call(args, {});
  }

  /**
   * A command that reaches the remote. The header goes through `GIT_CONFIG_COUNT`
   * in this one child's environment, never through arguments or `.git/config`.
   */
  async remote(args: readonly string[]): Promise<GitOutput> {
    return this.#call([...remoteArgs, ...args], {
      GIT_ASKPASS: "",
      GIT_ALLOW_PROTOCOL: this.#allowedProtocol(),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: this.#header(),
    });
  }

  /** `remote` that fails with `STAGE_GIT_FAILED` unless it exits 0. */
  async remoteRequired(args: readonly string[]): Promise<string> {
    return required(args, await this.remote(args));
  }
}

function required(args: readonly string[], output: GitOutput): string {
  if (output.exitCode !== 0) {
    throw gitFailed(args, output);
  }
  return output.stdout;
}

/** The command (without `-c` settings) and Git's redacted error output. */
export function gitFailed(args: readonly string[], output: GitOutput): StageError {
  const command = args.filter((arg, index) => arg !== "-c" && args[index - 1] !== "-c");
  const message = `git ${command[0]} failed: ${output.stderr.trim()}`;
  return new StageError("STAGE_GIT_FAILED", message);
}

/** The branch the workspace has checked out: the base branch of the Job. */
export async function checkedOutBranch(git: Git): Promise<string> {
  const output = await git.probe(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = output.stdout.trim();
  if (output.exitCode !== 0 || branch === "") {
    const message = "NIBFIN_WORKSPACE must have the base branch checked out by name";
    throw new StageError("STAGE_INPUT_INVALID", message);
  }
  return branch;
}

/** The commit of local branch `branch`, if it exists. */
export async function readBranchHead(git: Git, branch: string) {
  const output = await git.probe([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return output.exitCode === 0 ? output.stdout.trim() : undefined;
}

/** The commit of `branch` on the remote, if it exists there. */
async function remoteHead(git: Git, branch: string): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const listing = await git.remoteRequired(["ls-remote", git.remoteUrl, ref]);
  const line = listing.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
  return line?.split("\t")[0];
}

export interface PreparedBranch {
  base: string;
  branch: string;
  /** The remote head when fetched; `undefined` while the branch was never pushed. */
  remoteHead: string | undefined;
}

/**
 * Fetches the base and the Issue branch (unshallowing a shallow checkout, so a merge
 * base exists), checks out the existing branch or creates it from `origin/<base>`,
 * and sets the local commit identity to the actor.
 */
export async function prepareBranch(
  git: Git,
  options: { base: string; branch: string; actor: Actor },
): Promise<PreparedBranch> {
  const { base, branch, actor } = options;
  const existing = await remoteHead(git, branch);
  const shallow = (await git.run(["rev-parse", "--is-shallow-repository"])).trim();
  const refspecs = [`+refs/heads/${base}:refs/remotes/origin/${base}`];
  if (existing !== undefined) {
    refspecs.push(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  }
  const unshallow = shallow === "true" ? ["--unshallow"] : [];
  await git.remoteRequired([
    "fetch",
    "--no-tags",
    ...unshallow,
    git.remoteUrl,
    ...refspecs,
  ]);
  let fetched: string | undefined;
  if (existing !== undefined) {
    const tracking = `refs/remotes/origin/${branch}`;
    fetched = (await git.run(["rev-parse", "--verify", tracking])).trim();
    await git.run(["checkout", "--quiet", "--no-track", "-B", branch, tracking]);
  } else {
    const start = `refs/remotes/origin/${base}`;
    await git.run(["checkout", "--quiet", "--no-track", "-b", branch, start]);
  }
  await git.run(["config", "user.name", actor.login]);
  const email = `${actor.id}+${actor.login}@users.noreply.github.com`;
  await git.run(["config", "user.email", email]);
  return { base, branch, remoteHead: fetched };
}

/** The diff of the branch against the merge base with `origin/<base>`. */
export async function diffAgainstBase(git: Git, base: string): Promise<string> {
  return git.run(["diff", `refs/remotes/origin/${base}...HEAD`]);
}

/** The commits on `HEAD` that `origin/<base>` does not have. */
export async function commitsAhead(git: Git, base: string): Promise<number> {
  const count = await git.run([
    "rev-list",
    "--count",
    `refs/remotes/origin/${base}..HEAD`,
  ]);
  return Number(count.trim());
}

/** The full messages of the commits ahead of `origin/<base>`. */
export async function messagesAhead(git: Git, base: string): Promise<string[]> {
  const log = await git.run([
    "log",
    "--format=%B%x00",
    `refs/remotes/origin/${base}..HEAD`,
  ]);
  return log
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
}

/** `files` or `reftable`; Git before 2.45 has no reftable and no such query. */
export async function refFormat(git: Git): Promise<string> {
  // An older Git echoes the unknown option instead of failing.
  const output = await git.probe(["rev-parse", "--show-ref-format"]);
  return output.stdout.trim() === "reftable" ? "reftable" : "files";
}

/** The directory that holds the loose ref of `branch`. */
export async function refDirectory(git: Git, branch: string): Promise<string> {
  const parent = `refs/heads/${branch}`.split("/").slice(0, -1).join("/");
  const path = await git.run(["rev-parse", "--git-path", parent]);
  return resolve(git.workspace, path.replace(/\r?\n$/, ""));
}
