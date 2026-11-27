import type { ActingClient, IssueRef } from "../github/index.ts";
import { describeFailure, requestPerson } from "../stages/index.ts";

export { describeFailure };

export interface OutputStream {
  write(text: string): unknown;
}

export interface CliIo {
  stdout: OutputStream;
  stderr: OutputStream;
}

/** Prints a failure to stderr. */
export function printFailure(io: CliIo, error: unknown): void {
  io.stderr.write(`nibfin: ${describeFailure(error)}\n`);
}

/**
 * After a failure for a known Issue: sets `pending` with its comment (except for
 * `STAGE_WRITER_ACTIVE`). When that write fails too (GitHub unreachable), the run's
 * failure is the only record.
 */
export async function askPerson(
  io: CliIo,
  client: ActingClient,
  issue: IssueRef,
  error: unknown,
  url: string | undefined,
): Promise<void> {
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  try {
    if (await requestPerson(client, issue, error, url)) {
      io.stdout.write(`Added pending to ${name}\n`);
    }
  } catch (failure) {
    io.stderr.write(`nibfin: could not add pending: ${describeFailure(failure)}\n`);
  }
}
