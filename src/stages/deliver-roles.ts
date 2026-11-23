import type { StageRole } from "./prompt.ts";
import {
  blockedObject,
  invalidResult,
  parseAgentResult,
  resultFormat,
  textField,
} from "./result.ts";

const postedNote =
  "The stage posts `reason` on the Issue as written; never include credentials.";

export const writerRole: StageRole = {
  name: "deliver-writer",
  title: "Writer",
  skill: "deliver",
  readOnly: false,
  resultFormat: resultFormat(
    [
      '{"outcome": "done"}',
      '{"outcome": "shape-wrong", "reason": "<the exact conflicting Shape, Issue and ' +
        'product-authority clauses>"}',
      blockedObject,
    ],
    postedNote,
  ),
};

export const acceptorRole: StageRole = {
  name: "deliver-acceptor",
  title: "Accept sub agent",
  skill: "accept",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "pass"}',
      '{"outcome": "defects", "defects": ["<requirement, finding and source evidence>"]}',
      blockedObject,
    ],
    postedNote,
  ),
};

export type WriterResult =
  | { outcome: "done" }
  | { outcome: "shape-wrong"; reason: string }
  | { outcome: "blocked"; reason: string };

export type AcceptorResult =
  | { outcome: "pass" }
  | { outcome: "defects"; defects: string[] }
  | { outcome: "blocked"; reason: string };

export function parseWriterResult(finalMessage: string): WriterResult {
  const outcomes = ["done", "shape-wrong", "blocked"] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  if (result.outcome === "done") {
    return { outcome: "done" };
  }
  return { outcome: result.outcome, reason: textField(result, "reason", finalMessage) };
}

export function parseAcceptorResult(finalMessage: string): AcceptorResult {
  const outcomes = ["pass", "defects", "blocked"] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  if (result.outcome === "pass") {
    return { outcome: "pass" };
  }
  if (result.outcome === "blocked") {
    return { outcome: "blocked", reason: textField(result, "reason", finalMessage) };
  }
  const { defects } = result;
  const valid =
    Array.isArray(defects) &&
    defects.length > 0 &&
    defects.every((item) => typeof item === "string" && item.trim() !== "");
  if (!valid) {
    const reason = "defects must be a non-empty list of non-empty strings";
    throw invalidResult(reason, finalMessage);
  }
  return { outcome: "defects", defects: defects as string[] };
}
