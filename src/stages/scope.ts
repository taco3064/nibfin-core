import type { ActingClient } from "../github/index.ts";
import type { JobContext } from "./context.ts";
import { noNextAction, writeNextAction } from "./next.ts";

/** One line of the Job log. */
type Log = (line: string) => void;

const stdoutLog: Log = (line) => process.stdout.write(`${line}\n`);

/**
 * The Scope stage of a `request` Issue (Proposal R3.2, R4.8). Its work (the
 * Investigation, the Plan and the publication) is not implemented in this version:
 * it runs no agent, writes nothing to GitHub, leaves the workspace untouched and
 * ends with no next action (#734). `continueAfterStage` never re-routes the request
 * after a Scope run, so this writes no `pending` either.
 */
export async function runScopeStage(
  context: JobContext,
  _client: ActingClient,
  log: Log = stdoutLog,
): Promise<number> {
  const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
  log(`${where}: the Scope stage's work is not implemented in this version`);
  await writeNextAction(context, noNextAction, false);
  return 0;
}
