import type { StageRole } from "./prompt.ts";
import { type IssueAmendment, parseIssueAmendment } from "./repair-roles.ts";
import {
  blockedObject,
  invalidResult,
  parseAgentResult,
  resultFormat,
  textField,
} from "./result.ts";

export const shapeAuthorRole: StageRole = {
  name: "shape-author",
  title: "Shape Author",
  skill: "shape",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "ready", "shape": "<the complete proposed Shape, Markdown>"}',
      blockedObject,
    ],
    "The stage posts `shape` or `reason` on the Issue as written, so follow the " +
      "skill's Disclosure rules. Do not start `shape` with a `<!-- nibfin:` marker; " +
      "the stage adds it.",
  ),
};

export const shapeValidatorRole: StageRole = {
  name: "shape-validator",
  title: "Shape Validator",
  skill: "shape",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "approved"}',
      '{"outcome": "changes-required", "findings": ["<one targeted finding>"]}',
      blockedObject,
    ],
    "The stage posts `reason` on the Issue as written, so follow the skill's " +
      "Disclosure rules.",
  ),
};

export type AuthorResult =
  { outcome: "ready"; shape: string } | { outcome: "blocked"; reason: string };

export type ValidatorResult =
  | { outcome: "approved" }
  | { outcome: "changes-required"; findings: string[] }
  | { outcome: "blocked"; reason: string };

/** Line endings as GitHub keeps them, without surrounding blank space. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function parseAuthorResult(finalMessage: string): AuthorResult {
  const result = parseAgentResult(finalMessage, ["ready", "blocked"] as const);
  if (result.outcome === "blocked") {
    return { outcome: "blocked", reason: textField(result, "reason", finalMessage) };
  }
  const shape = normalize(textField(result, "shape", finalMessage));
  if (shape.startsWith("<!-- nibfin:")) {
    throw invalidResult("shape must not start with a nibfin marker", finalMessage);
  }
  return { outcome: "ready", shape };
}

export function parseValidatorResult(finalMessage: string): ValidatorResult {
  const outcomes = ["approved", "changes-required", "blocked"] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  if (result.outcome === "approved") {
    return { outcome: "approved" };
  }
  if (result.outcome === "blocked") {
    return { outcome: "blocked", reason: textField(result, "reason", finalMessage) };
  }
  const { findings } = result;
  const valid =
    Array.isArray(findings) &&
    findings.length > 0 &&
    findings.every((item) => typeof item === "string" && item.trim() !== "");
  if (!valid) {
    const reason = "findings must be a non-empty list of non-empty strings";
    throw invalidResult(reason, finalMessage);
  }
  return { outcome: "changes-required", findings: findings as string[] };
}

/**
 * Turns the option a Collaborator chose on a repair record into the Issue change it
 * describes (#779, Proposal R4.51). Core writes the change; this role does not shape.
 */
export const shapeChoiceRole: StageRole = {
  name: "shape-choice",
  title: "Shape Author (chosen option)",
  skill: "shape",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "amend", "body": "<the complete new Issue body>" | null, ' +
        '"blockedBy": ["<Issue URL>"], "changeSummary": "<one line: what changed>"}',
      blockedObject,
    ],
    "`body` is null when the body stays as it is; `blockedBy` lists only Issue URLs " +
      "to add as Blocked by (empty when none). The body keeps every `Origin:` line " +
      "of the current body. The stage writes `body` as the Issue body and posts " +
      "`changeSummary` or `reason` on the Issue as written, so they must be safe at " +
      "the Issue repository's visibility: follow the skill's Disclosure rules.",
  ),
};

export type ChoiceResult =
  (IssueAmendment & { outcome: "amend" }) | { outcome: "blocked"; reason: string };

/**
 * The choice role's result: an Issue change checked by `parseIssueAmendment` against
 * `currentBody` (an empty change is valid: the option leaves the Issue as it is), or
 * blocked. Anything else is `STAGE_RESULT_INVALID`.
 */
export function parseChoiceResult(
  finalMessage: string,
  currentBody: string,
): ChoiceResult {
  const result = parseAgentResult(finalMessage, ["amend", "blocked"] as const);
  if (result.outcome === "blocked") {
    return { outcome: "blocked", reason: textField(result, "reason", finalMessage) };
  }
  const amendment = parseIssueAmendment(result, currentBody, finalMessage, true);
  return { outcome: "amend", ...amendment };
}
