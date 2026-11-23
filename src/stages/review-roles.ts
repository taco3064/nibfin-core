import type { StageRole } from "./prompt.ts";
import { invalidResult, parseAgentResult, resultFormat, textField } from "./result.ts";

export const reviewerRole: StageRole = {
  name: "pr-review",
  title: "PR review",
  skill: "shape",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "clean", "reviewedHead": "<the full SHA you reviewed>"}',
      '{"outcome": "problems", "reviewedHead": "<the full SHA you reviewed>", ' +
        '"problems": ["<one problem Deliver can fix within the Shape>"]}',
      '{"outcome": "blocked", "reviewedHead": "<the full SHA you reviewed>", ' +
        '"reason": "<the underlying cause and evidence>"}',
    ],
    "`reviewedHead` must be the pinned head named in the input. The stage posts " +
      "`problems` on the pull request and `reason` on the Issue as written, so follow " +
      "the skill's Disclosure rules and never include credentials.",
  ),
};

export type ReviewerResult =
  | { outcome: "clean"; reviewedHead: string }
  | { outcome: "problems"; reviewedHead: string; problems: string[] }
  | { outcome: "blocked"; reviewedHead: string; reason: string };

/**
 * The reviewer's result; its `reviewedHead` must be `head`, the pinned head, or the
 * result is `STAGE_RESULT_INVALID`.
 */
export function parseReviewerResult(finalMessage: string, head: string): ReviewerResult {
  const outcomes = ["clean", "problems", "blocked"] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  const reviewedHead = textField(result, "reviewedHead", finalMessage);
  if (reviewedHead !== head) {
    const reason = `reviewedHead ${reviewedHead} is not the pinned head ${head}`;
    throw invalidResult(reason, finalMessage);
  }
  if (result.outcome === "clean") {
    return { outcome: "clean", reviewedHead };
  }
  if (result.outcome === "blocked") {
    const reason = textField(result, "reason", finalMessage);
    return { outcome: "blocked", reviewedHead, reason };
  }
  const { problems } = result;
  const valid =
    Array.isArray(problems) &&
    problems.length > 0 &&
    problems.every((item) => typeof item === "string" && item.trim() !== "");
  if (!valid) {
    const reason = "problems must be a non-empty list of non-empty strings";
    throw invalidResult(reason, finalMessage);
  }
  return { outcome: "problems", reviewedHead, problems: problems as string[] };
}
