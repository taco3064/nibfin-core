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
 * Settings for the calls in Core's own repository: no hooks, credential helpers,
 * askpass programs or signing commands run while the token is in the environment.
 */
/**
 * The null device as Git spells it on every platform (Git for Windows maps it too);
 * used where Git must find no config file and no hooks.
 */
export const gitNullPath = "/dev/null";

/** No global or system config and no askpass for commands in Core's repository. */
const isolated = {
  GIT_CONFIG_GLOBAL: gitNullPath,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "",
};

const coreArgs = [
  "-c",
  `core.hooksPath=${gitNullPath}`,
  "-c",
  "credential.helper=",
  "-c",
  "push.gpgSign=false",
];

/**
 * The Git commands Core runs. Local commands run in the workspace without the token.
 * Remote commands run in `coreRepo`, a bare repository Core owns outside the
 * workspace, so no configuration the agent can write (the workspace's config, the
 * global or system config) applies while the token is in the environment.
 */
export class Git {
  readonly workspace: string;
  readonly coreRepo: string;
  readonly remoteUrl: string;
  readonly #token: string;
  readonly #run: GitRunner;

  constructor(options: {
    workspace: string;
    coreRepo: string;
    remoteUrl: string;
    token: string;
    run: GitRunner;
  }) {
    this.workspace = options.workspace;
    this.coreRepo = options.coreRepo;
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

  async #call(
    args: readonly string[],
    extra: Record<string, string>,
    cwd = this.workspace,
  ) {
    const env = childEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0", ...extra });
    const output = await this.#run({ args, cwd, env });
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

  /** Creates Core's bare repository: no template, so no hooks or other files. */
  async initCoreRepo(): Promise<void> {
    await this.coreRequired(["init", "--quiet", "--bare", "--template=", "."]);
  }

  /** A command in Core's repository without the token; only Core's config applies. */
  async core(args: readonly string[]): Promise<GitOutput> {
    return this.#call([...coreArgs, ...args], isolated, this.coreRepo);
  }

  /** `core` that fails with `STAGE_GIT_FAILED` unless it exits 0. */
  async coreRequired(args: readonly string[]): Promise<string> {
    return required(args, await this.core(args));
  }

  /**
   * A command in Core's repository that reaches the remote. The header goes through
   * `GIT_CONFIG_COUNT` in this one child's environment, never through arguments or a
   * config file, and only the remote URL's protocol is allowed.
   */
  async remote(args: readonly string[]): Promise<GitOutput> {
    const auth = {
      ...isolated,
      GIT_ALLOW_PROTOCOL: this.#allowedProtocol(),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: this.#header(),
    };
    return this.#call([...coreArgs, ...args], auth, this.coreRepo);
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

/** The commit of `branch` on the remote, if it exists there. */
async function remoteHead(git: Git, branch: string): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const listing = await git.remoteRequired(["ls-remote", git.remoteUrl, ref]);
  const line = listing.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
  return line?.split("\t")[0];
}

/**
 * Brings `refs` from Core's repository into the workspace under the same names,
 * unshallowing a shallow checkout so a merge base exists. No token is involved.
 */
async function fetchFromCore(git: Git, refs: readonly string[]): Promise<void> {
  const shallow = (await git.run(["rev-parse", "--is-shallow-repository"])).trim();
  const unshallow = shallow === "true" ? ["--unshallow"] : [];
  const specs = refs.map((ref) => `+${ref}:${ref}`);
  await git.run(["fetch", "--no-tags", ...unshallow, git.coreRepo, ...specs]);
}

export interface PreparedBranch {
  base: string;
  branch: string;
  /** The remote head when fetched; `undefined` while the branch was never pushed. */
  remoteHead: string | undefined;
}

/**
 * Creates Core's repository and fetches the base and the Issue branch into it with
 * full history, then brings them into the workspace from there (unshallowing a
 * shallow checkout, so a merge base exists). Checks out the existing branch or creates
 * it from `origin/<base>`, and sets the local commit identity to the actor.
 */
export async function prepareBranch(
  git: Git,
  options: { base: string; branch: string; actor: Actor },
): Promise<PreparedBranch> {
  const { base, branch, actor } = options;
  await git.initCoreRepo();
  const existing = await remoteHead(git, branch);
  const names = existing === undefined ? [base] : [base, branch];
  const tracking = (name: string) => `refs/remotes/origin/${name}`;
  const fromGitHub = names.map((name) => `+refs/heads/${name}:${tracking(name)}`);
  await git.remoteRequired(["fetch", "--no-tags", git.remoteUrl, ...fromGitHub]);
  await fetchFromCore(git, names.map(tracking));
  let fetched: string | undefined;
  if (existing !== undefined) {
    fetched = (
      await git.coreRequired(["rev-parse", "--verify", tracking(branch)])
    ).trim();
    const start = tracking(branch);
    await git.run(["checkout", "--quiet", "--no-track", "-B", branch, start]);
  } else {
    const start = `refs/remotes/origin/${base}`;
    await git.run(["checkout", "--quiet", "--no-track", "-b", branch, start]);
  }
  await git.run(["config", "user.name", actor.login]);
  const email = `${actor.id}+${actor.login}@users.noreply.github.com`;
  await git.run(["config", "user.email", email]);
  return { base, branch, remoteHead: fetched };
}

/**
 * Fetches the workspace's `branch` into Core's repository under the same name
 * (without the token) and returns its head there.
 */
export async function fetchWorkspaceBranch(git: Git, branch: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  await git.coreRequired(["fetch", "--no-tags", git.workspace, `+${ref}:${ref}`]);
  return (await git.coreRequired(["rev-parse", "--verify", ref])).trim();
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

/**
 * Fetches the pinned `head` (by SHA) and the base into Core's repository, brings
 * both into the workspace from there (unshallowing a shallow checkout) and checks
 * `head` out detached. Returns the diff of `head` against its merge base with
 * `origin/<base>`.
 */
export async function checkoutReviewedHead(
  git: Git,
  options: { base: string; head: string },
): Promise<string> {
  const { base, head } = options;
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new StageError("STAGE_INPUT_INVALID", `Not a full commit SHA: ${head}`);
  }
  await git.initCoreRepo();
  const baseRef = `refs/remotes/origin/${base}`;
  const reviewed = "refs/nibfin/reviewed";
  await git.remoteRequired([
    "fetch",
    "--no-tags",
    git.remoteUrl,
    `+refs/heads/${base}:${baseRef}`,
    `+${head}:${reviewed}`,
  ]);
  await fetchFromCore(git, [baseRef, reviewed]);
  await git.run(["checkout", "--quiet", "--detach", head]);
  return git.run(["diff", `${baseRef}...${head}`]);
}
