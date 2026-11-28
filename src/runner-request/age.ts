// `age` for a runner request (#776): the registration token is encrypted to the
// requester's SSH key. `age` runs with only `PATH` in its environment, so no token
// of the Action's own environment (`INPUT_*`) reaches it (R3.49).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Command,
  describeExit,
  type ExitStatus,
  runQuiet,
  runStreaming,
} from "../agent/process.ts";

/** What a runner request needs from `age`. */
export interface Age {
  /** Resolves when `age --version` runs; rejects with `AgeError` otherwise. */
  check(): Promise<void>;
  /** The ASCII-armored ciphertext of `plaintext` for the SSH public key `recipient`. */
  encrypt(recipient: string, plaintext: string): Promise<string>;
}

/** `age` could not run, or failed; the message never carries its input or output. */
export class AgeError extends Error {
  readonly code = "RUNNER_AGE_FAILED";

  constructor(what: string, reason: string) {
    super(`${what} failed (${reason})`);
    this.name = "AgeError";
  }
}

/** The only variable `age` gets. */
function ageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.PATH === undefined ? {} : { PATH: env.PATH };
}

async function exitOf(what: string, run: () => Promise<ExitStatus>): Promise<void> {
  let status: ExitStatus;
  try {
    status = await run();
  } catch (error) {
    // A process that did not start: Node's error code, such as ENOENT.
    throw new AgeError(what, String((error as NodeJS.ErrnoException).code));
  }
  if (status.exitCode !== 0) {
    throw new AgeError(what, describeExit(status));
  }
}

/**
 * `age` as `command` runs it (`age` from `PATH` by default), with only `PATH` from
 * `env`. `encrypt` runs `age -a -R <file>` with the recipient in a file of a fresh
 * temporary directory, removed afterwards, and the plaintext on stdin.
 */
export function createAge(
  env: NodeJS.ProcessEnv,
  command: Command = { command: "age", args: [] },
): Age {
  const request = { command, cwd: tmpdir(), env: ageEnv(env) };
  return {
    check: () =>
      exitOf("age --version", () => runQuiet({ ...request, args: ["--version"] })),
    async encrypt(recipient, plaintext) {
      const dir = await mkdtemp(join(tmpdir(), "nibfin-age-"));
      try {
        const file = join(dir, "recipient.pub");
        await writeFile(file, `${recipient}\n`);
        let stdout = "";
        await exitOf("age -a -R", () =>
          runStreaming({
            ...request,
            args: ["-a", "-R", file],
            stdin: plaintext,
            stdout: { write: (chunk) => (stdout += Buffer.from(chunk).toString()) },
            stderr: { write: () => undefined },
            onLine: () => undefined,
          }),
        );
        return stdout;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
