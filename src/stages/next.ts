import { readFile, writeFile } from "node:fs/promises";
import { type FixReason, fixReasons, type JobContext } from "./context.ts";
import { StageError } from "./errors.ts";

/** An Issue whose next stage should run now, as `<owner>/<repo>` and number. */
export interface WakeTarget {
  repo: string;
  issue: number;
}

/**
 * What should run next for the Issue (#673, #674). `stage: null` when nothing should:
 * the stage ended ineligible or blocked, or the next step waits for CI or CD events.
 * `stage: "deliver"` with a `reason` asks for that Deliver fix run. `stage: "shape"`
 * asks for the Shape stage (#686), `stage: "scope"` the Scope stage of a `request`
 * Issue (#734). `stage: "finish"` asks for the review stage's steps
 * that run no agent (merge after a recorded review, closing, waking), which run on a
 * GitHub-hosted runner for a public execution repository. `wake` names other Issues
 * that became eligible.
 */
export interface NextAction {
  stage: "scope" | "shape" | "deliver" | "review" | "finish" | null;
  reason: FixReason | null;
  wake?: WakeTarget[];
}

/**
 * The next-action file: the action plus `progressed`, true when the run wrote to
 * GitHub (comment, label, push, PR, merge, close) or found a PR head other than the
 * one it started with (#674).
 */
export interface NextActionRecord extends NextAction {
  progressed: boolean;
}

export const noNextAction: NextAction = { stage: null, reason: null };

/** Writes `action` as JSON to `NIBFIN_NEXT_FILE`; does nothing when it is not set. */
export async function writeNextAction(
  context: Pick<JobContext, "nextFile">,
  action: NextAction,
  progressed: boolean,
): Promise<void> {
  if (context.nextFile === undefined) {
    return;
  }
  const json = {
    stage: action.stage,
    reason: action.reason,
    ...(action.wake === undefined
      ? {}
      : { wake: action.wake.map(({ repo, issue }) => ({ repo, issue })) }),
    progressed,
  };
  await writeFile(context.nextFile, `${JSON.stringify(json)}\n`);
}

const stages = ["scope", "shape", "deliver", "review", "finish", null];
const repoPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function isWakeTarget(value: unknown): value is WakeTarget {
  const target = value as Partial<WakeTarget> | null;
  return (
    typeof target === "object" &&
    target !== null &&
    typeof target.repo === "string" &&
    repoPattern.test(target.repo) &&
    typeof target.issue === "number" &&
    Number.isSafeInteger(target.issue) &&
    target.issue > 0
  );
}

function isRecord(value: unknown): value is NextActionRecord {
  const record = value as Partial<NextActionRecord> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    stages.includes(record.stage as string | null) &&
    (record.reason === null || fixReasons.some((reason) => reason === record.reason)) &&
    (record.wake === undefined ||
      (Array.isArray(record.wake) && record.wake.every(isWakeTarget))) &&
    typeof record.progressed === "boolean"
  );
}

/** Reads the next-action file a stage wrote; a malformed one is invalid input. */
export async function readNextAction(path: string): Promise<NextActionRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = "NIBFIN_NEXT_FILE could not be read as JSON";
    throw new StageError("STAGE_INPUT_INVALID", message, error);
  }
  if (!isRecord(value)) {
    throw new StageError("STAGE_INPUT_INVALID", "NIBFIN_NEXT_FILE is malformed");
  }
  return value;
}
