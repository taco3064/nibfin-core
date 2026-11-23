import { isRecord, type JsonRecord } from "../agent/json.ts";
import { StageError } from "./errors.ts";

export const resultFence = "```nibfin-result";
const closingFence = "```";

/** The result instructions of a role: the block, its JSON objects, then a note. */
export function resultFormat(objects: readonly string[], note: string): string {
  return [
    "End your final message with one block like this; only the last such block counts:",
    "",
    resultFence,
    "<one of the JSON objects below>",
    "```",
    "",
    `Its opening line must be exactly ${resultFence} and its closing line exactly`,
    "```. The JSON object is one of:",
    "",
    ...objects,
    "",
    note,
  ].join("\n");
}

export const blockedObject =
  '{"outcome": "blocked", "reason": "<the underlying cause and evidence>"}';

/** The text of the last fenced `nibfin-result` block, if any block is complete. */
function lastResultBlock(finalMessage: string): string | undefined {
  let block: string[] | undefined;
  let last: string | undefined;
  for (const line of finalMessage.split(/\r?\n/)) {
    if (block === undefined) {
      block = line === resultFence ? [] : undefined;
    } else if (line === closingFence) {
      last = block.join("\n");
      block = undefined;
    } else {
      block.push(line);
    }
  }
  return last;
}

/** A result the stage cannot use; the message keeps the agent's final message. */
export function invalidResult(reason: string, finalMessage: string): StageError {
  const message =
    `The agent result is invalid: ${reason}.\n` + `Final message:\n${finalMessage}`;
  return new StageError("STAGE_RESULT_INVALID", message);
}

/**
 * The JSON object in the last block whose opening line is exactly ```` ```nibfin-result
 * ```` and closing line exactly ```` ``` ````, with an `outcome` from `outcomes`.
 * Anything else is `STAGE_RESULT_INVALID`. Role schemas check the other fields.
 */
export function parseAgentResult<Outcome extends string>(
  finalMessage: string,
  outcomes: readonly Outcome[],
): JsonRecord & { outcome: Outcome } {
  const block = lastResultBlock(finalMessage);
  if (block === undefined) {
    throw invalidResult("no nibfin-result block", finalMessage);
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    throw invalidResult("the nibfin-result block is not JSON", finalMessage);
  }
  if (!isRecord(value)) {
    throw invalidResult("the nibfin-result block is not a JSON object", finalMessage);
  }
  const outcome = outcomes.find((candidate) => candidate === value.outcome);
  if (outcome === undefined) {
    const expected = outcomes.map((name) => JSON.stringify(name)).join(", ");
    throw invalidResult(`outcome must be one of ${expected}`, finalMessage);
  }
  return { ...value, outcome };
}

/** A non-empty string field of a result, else `STAGE_RESULT_INVALID`. */
export function textField(
  result: JsonRecord,
  field: string,
  finalMessage: string,
): string {
  const value = result[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidResult(`${field} must be a non-empty string`, finalMessage);
  }
  return value;
}
