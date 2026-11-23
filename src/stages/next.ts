import { writeFile } from "node:fs/promises";
import type { FixReason, JobContext } from "./context.ts";

/**
 * What should run next for the Issue (#673, #674). `stage: null` when nothing should:
 * the stage ended ineligible or blocked, or the next step waits for CI events.
 */
export interface NextAction {
  stage: "review" | null;
  reason: FixReason | null;
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
  const json = { stage: action.stage, reason: action.reason };
  await writeFile(context.nextFile, `${JSON.stringify(json)}\n`);
}
