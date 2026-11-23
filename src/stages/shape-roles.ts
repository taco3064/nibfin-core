import type { StageRole } from "./prompt.ts";
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
