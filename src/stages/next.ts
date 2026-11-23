import { writeFile } from "node:fs/promises";
import type { FixReason, JobContext } from "./context.ts";

/** An Issue whose next stage should run now, as `<owner>/<repo>` and number. */
export interface WakeTarget {
  repo: string;
  issue: number;
}

/**
 * What should run next for the Issue (#673, #674). `stage: null` when nothing should:
 * the stage ended ineligible or blocked, or the next step waits for CI or CD events.
 * `stage: "deliver"` with a `reason` asks for that Deliver fix run. `stage: "shape"`
 * asks for the Shape stage (#686). `wake` names other Issues that became eligible.
 */
export interface NextAction {
  stage: "shape" | "deliver" | "review" | null;
  reason: FixReason | null;
  wake?: WakeTarget[];
}

export const noNextAction: NextAction = { stage: null, reason: null };

/** Writes `action` as JSON to `NIBFIN_NEXT_FILE`; does nothing when it is not set. */
export async function writeNextAction(
  context: Pick<JobContext, "nextFile">,
  action: NextAction,
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
  };
  await writeFile(context.nextFile, `${JSON.stringify(json)}\n`);
}
