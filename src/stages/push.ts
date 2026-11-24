import { StageError } from "./errors.ts";
import { fetchWorkspaceBranch, type Git, gitFailed, type GitOutput } from "./git.ts";
import {
  isUnprotected,
  protectedChanges,
  protectedPathError,
  type ProtectedSet,
} from "./protected-paths.ts";

export interface PusherOptions {
  git: Git;
  /** The base branch; a head without commits ahead of `origin/<base>` is not pushed. */
  base: string;
  branch: string;
  /** A head that differs from `origin/<base>` on one of these paths is not pushed. */
  protectedSet: ProtectedSet;
  /** The remote head Core fetched; `undefined` while the branch was never pushed. */
  remoteHead: string | undefined;
  /**
   * Called right before each push; `false` stops all further pushes, for example when
   * the Issue was paused meanwhile. Nothing is pushed after that.
   */
  beforePush: () => Promise<boolean>;
  log: (line: string) => void;
}

/** Why a push did not happen; the message keeps Git's redacted output. */
function rejected(branch: string, expected: string | undefined, output: GitOutput) {
  const detail = `${output.stdout}\n${output.stderr}`.trim();
  if (/without `workflows?` (permission|scope)/.test(detail)) {
    const message =
      `GitHub rejected the push of ${branch}: the change touches .github/workflows/ ` +
      `and the token lacks the workflows permission.\n${detail}`;
    return new StageError("STAGE_PUSH_REJECTED", message);
  }
  if (/\bstale info\b/.test(detail)) {
    const lease = expected ?? "absent";
    const message =
      `The remote ${branch} is no longer at ${lease}, the head Nibfin last ` +
      `pushed or fetched; it was not overwritten.\n${detail}`;
    return new StageError("STAGE_PUSH_REJECTED", message);
  }
  if (/\[(remote )?rejected\]/.test(detail)) {
    const message = `GitHub rejected the push of ${branch}.\n${detail}`;
    return new StageError("STAGE_PUSH_REJECTED", message);
  }
  return gitFailed(["push"], output);
}

/**
 * Pushes the workspace branch head from Core's own repository (`Git.coreRepo`): Core
 * fetches the branch from the workspace into it, then pushes with a lease on the
 * remote head Core last pushed (or fetched before its first push); an empty lease
 * while the branch was never pushed.
 * Pushes run one at a time, and requests during a push collapse into one follow-up
 * push of the then current head. A failed push is never retried as an overwrite: it
 * stops all further pushes and `flush` reports it. A head with no commits ahead of
 * the base is never pushed; a head that differs from the base on a protected path
 * fails with `STAGE_PROTECTED_PATH` instead of being pushed.
 */
export class BranchPusher {
  readonly #options: PusherOptions;
  #remote: string | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #failure: Error | undefined;
  #halted = false;

  constructor(options: PusherOptions) {
    this.#options = options;
    this.#remote = options.remoteHead;
  }

  /** The remote head as Core last knows it. */
  get remoteHead(): string | undefined {
    return this.#remote;
  }

  /** True once `beforePush` stopped the pushes. */
  get halted(): boolean {
    return this.#halted;
  }

  /**
   * Pushes the current head when it changed. A request during a push is served by one
   * more push after it. Never rejects (see `flush`).
   */
  request(): Promise<void> {
    this.#again = true;
    this.#running ??= this.#drain();
    return this.#running;
  }

  /** Pushes what is pending, then reports the first failed push, if any. */
  async flush(): Promise<void> {
    await this.request();
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  async #drain(): Promise<void> {
    // Lets `request` store this promise before the loop can end.
    await Promise.resolve();
    while (this.#again && this.#failure === undefined && !this.#halted) {
      this.#again = false;
      try {
        await this.#pushOnce();
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.#running = undefined;
  }

  async #pushOnce(): Promise<void> {
    const { git, base, branch, log } = this.#options;
    const ref = `refs/heads/${branch}`;
    const head = await fetchWorkspaceBranch(git, branch);
    if (head === this.#remote) {
      return;
    }
    const range = `refs/remotes/origin/${base}..${head}`;
    const ahead = await git.coreRequired(["rev-list", "--count", range]);
    if (Number(ahead.trim()) === 0) {
      log(`${branch} has no commits ahead of ${base}; nothing is pushed`);
      return;
    }
    const changes = await protectedChanges(git, base, head, this.#options.protectedSet);
    if (!isUnprotected(changes)) {
      throw protectedPathError(branch, base, changes);
    }
    if (!(await this.#options.beforePush())) {
      this.#halted = true;
      return;
    }
    const output = await git.remote([
      "push",
      "--no-verify",
      `--force-with-lease=${ref}:${this.#remote ?? ""}`,
      git.remoteUrl,
      `${head}:${ref}`,
    ]);
    if (output.exitCode !== 0) {
      throw rejected(branch, this.#remote, output);
    }
    this.#remote = head;
    log(`Pushed ${branch} at ${head}`);
  }
}
