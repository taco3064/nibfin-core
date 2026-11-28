// The repair agent's role and result (#778, Proposal R4.41–R4.48): Core accepts only
// the four outcomes below, each with its classes, and checks every field.
import { isRecord, type JsonRecord } from "../agent/json.ts";
import type { StageRole } from "./prompt.ts";
import { invalidResult, parseAgentResult, resultFormat, textField } from "./result.ts";

/** The classes of R4.41, by letter. */
export const repairClasses = {
  A: "external temporary problem",
  B: "Nibfin flow error",
  C: "unrelated flaky test",
  D: "Issue correction",
  E: "product decision",
  F: "operation or manual action",
} as const;

export type RepairClass = keyof typeof repairClasses;

const outcomes = ["RERUN", "AMEND", "DECIDE", "FOLLOW_UP"] as const;

/** Which classes each outcome takes; anything else is `STAGE_RESULT_INVALID`. */
const classesOf: Record<(typeof outcomes)[number], readonly RepairClass[]> = {
  RERUN: ["A", "B", "C"],
  AMEND: ["D"],
  DECIDE: ["E"],
  FOLLOW_UP: ["A", "B", "C", "D", "E", "F"],
};

export interface RepairOption {
  title: string;
  consequence: string;
  issueChange: string;
  recommended: boolean;
}

/** A follow-up step: its text with a link, a command, or both. */
export interface RepairStep {
  text: string;
  link?: string;
  command?: string;
}

interface RepairBase {
  class: RepairClass;
  summary: string;
  evidence: string[];
}

export type RepairResult = RepairBase &
  (
    | { outcome: "RERUN" }
    | {
        outcome: "AMEND";
        /** The full new Issue body; `null` when only `Blocked by` is added. */
        body: string | null;
        /** Issue URLs to add as native Blocked by. */
        blockedBy: string[];
        changeSummary: string;
      }
    | { outcome: "DECIDE"; options: RepairOption[] }
    | {
        outcome: "FOLLOW_UP";
        steps: RepairStep[];
        /** Only for B. */
        bugReport?: { title: string; body: string };
      }
  );

const base =
  '"class": "A" | "B" | "C" | "D" | "E" | "F", "summary": "<one sentence>", ' +
  '"evidence": ["<a fact with its source>"]';

export const repairRole: StageRole = {
  name: "repair",
  title: "Repair",
  skill: "repair",
  readOnly: true,
  resultFormat: resultFormat(
    [
      `{${base}, "outcome": "RERUN"}`,
      `{${base}, "outcome": "AMEND", "body": "<the full new Issue body>" | null, ` +
        '"blockedBy": ["<Issue URL>"], "changeSummary": "<what changed, why, ' +
        'and the evidence>"}',
      `{${base}, "outcome": "DECIDE", "options": [{"title": "<title>", ` +
        '"consequence": "<one sentence; the recommended one ends with why>", ' +
        '"issueChange": "<how the Issue would change>", "recommended": true | false}]}',
      `{${base}, "outcome": "FOLLOW_UP", "steps": [{"text": "<the step>", ` +
        '"link": "<https URL>", "command": "<a command to copy>"}], ' +
        '"bugReport": {"title": "<title>", "body": "<Markdown body>"}}',
    ],
    "RERUN takes class A, B or C; AMEND only D; DECIDE only E, with 2 to 4 options " +
      "and exactly one recommended; FOLLOW_UP any class. Each step has a `link`, a " +
      "`command` or both. `bugReport` is required for class B with FOLLOW_UP and not " +
      "allowed otherwise. AMEND has a non-null `body` or a non-empty `blockedBy`, " +
      "keeps every `Origin:` line of the current body, and `blockedBy` holds Issue " +
      "URLs. Core posts the summary, evidence, change summary, options, steps and bug " +
      "report on the Issue as written, so they must be safe at the Issue " +
      "repository's visibility (see the Visibility section): when it is public, quote " +
      "no private source excerpts, private Issue text, internal logs or secrets from " +
      "another repository. An `internal` repository counts as private.",
  ),
};

/** What the parser checks a result against. */
export interface RepairParseContext {
  /** The Issue body the agent was given (AMEND keeps its `Origin:` lines). */
  body: string;
  /** This cause already received an automatic step: RERUN and AMEND are invalid. */
  guard: boolean;
}

const issueUrlPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/[1-9]\d*$/;

function strings(
  result: JsonRecord,
  field: string,
  finalMessage: string,
  allowEmpty: boolean,
): string[] {
  const value = result[field];
  const valid =
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => typeof item === "string" && item.trim() !== "");
  if (!valid) {
    const what = allowEmpty ? "a list of" : "a non-empty list of";
    throw invalidResult(`${field} must be ${what} non-empty strings`, finalMessage);
  }
  return value as string[];
}

function records(value: unknown, field: string, finalMessage: string): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw invalidResult(`${field} must be a list of objects`, finalMessage);
  }
  return value;
}

function originLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Origin: "));
}

function parseAmend(
  result: JsonRecord,
  context: RepairParseContext,
  finalMessage: string,
) {
  const raw = result.body ?? null;
  if (raw !== null && typeof raw !== "string") {
    throw invalidResult("body must be a string or null", finalMessage);
  }
  const blockedBy =
    result.blockedBy === undefined
      ? []
      : strings(result, "blockedBy", finalMessage, true);
  if (!blockedBy.every((url) => issueUrlPattern.test(url))) {
    throw invalidResult("blockedBy must hold Issue URLs", finalMessage);
  }
  if (raw === null && blockedBy.length === 0) {
    throw invalidResult("AMEND needs a body or a blockedBy", finalMessage);
  }
  if (raw !== null) {
    const kept = new Set(originLines(raw));
    if (!originLines(context.body).every((line) => kept.has(line))) {
      throw invalidResult("body must keep every Origin: line", finalMessage);
    }
  }
  const changeSummary = textField(result, "changeSummary", finalMessage);
  return { outcome: "AMEND" as const, body: raw, blockedBy, changeSummary };
}

function parseOptions(result: JsonRecord, finalMessage: string): RepairOption[] {
  const options = records(result.options, "options", finalMessage).map((option) => {
    if (typeof option.recommended !== "boolean") {
      throw invalidResult("each option needs recommended: true or false", finalMessage);
    }
    return {
      title: textField(option, "title", finalMessage),
      consequence: textField(option, "consequence", finalMessage),
      issueChange: textField(option, "issueChange", finalMessage),
      recommended: option.recommended,
    };
  });
  if (options.length < 2 || options.length > 4) {
    throw invalidResult("DECIDE needs 2 to 4 options", finalMessage);
  }
  if (options.filter((option) => option.recommended).length !== 1) {
    throw invalidResult("exactly one option must be recommended", finalMessage);
  }
  return options;
}

function optionalText(
  value: JsonRecord,
  field: string,
  finalMessage: string,
): string | undefined {
  return value[field] === undefined ? undefined : textField(value, field, finalMessage);
}

function parseSteps(result: JsonRecord, finalMessage: string): RepairStep[] {
  const steps = records(result.steps, "steps", finalMessage).map((step) => {
    const link = optionalText(step, "link", finalMessage);
    const command = optionalText(step, "command", finalMessage);
    if (link === undefined && command === undefined) {
      throw invalidResult("each step needs a link or a command", finalMessage);
    }
    if (link !== undefined && !/^https:\/\/\S+$/.test(link)) {
      throw invalidResult("a step's link must be an https URL", finalMessage);
    }
    return {
      text: textField(step, "text", finalMessage),
      ...(link === undefined ? {} : { link }),
      ...(command === undefined ? {} : { command }),
    };
  });
  if (steps.length === 0) {
    throw invalidResult("FOLLOW_UP needs at least one step", finalMessage);
  }
  return steps;
}

function parseFollowUp(result: JsonRecord, kind: RepairClass, finalMessage: string) {
  const steps = parseSteps(result, finalMessage);
  const report = result.bugReport;
  if (kind !== "B") {
    if (report !== undefined && report !== null) {
      throw invalidResult("bugReport is only for class B", finalMessage);
    }
    return { outcome: "FOLLOW_UP" as const, steps };
  }
  if (!isRecord(report)) {
    throw invalidResult("class B needs a bugReport", finalMessage);
  }
  const bugReport = {
    title: textField(report, "title", finalMessage),
    body: textField(report, "body", finalMessage),
  };
  return { outcome: "FOLLOW_UP" as const, steps, bugReport };
}

/**
 * The repair agent's result: `class` A–F, a one-line `summary`, a non-empty
 * `evidence` list and one outcome with the classes it takes (`classesOf`). With the
 * guard (R4.47), RERUN and AMEND are invalid. Any violation is
 * `STAGE_RESULT_INVALID`.
 */
export function parseRepairResult(
  finalMessage: string,
  context: RepairParseContext,
): RepairResult {
  const result = parseAgentResult(finalMessage, outcomes);
  const kind = result.class;
  if (typeof kind !== "string" || !Object.hasOwn(repairClasses, kind)) {
    throw invalidResult("class must be one of A, B, C, D, E and F", finalMessage);
  }
  const repairClass = kind as RepairClass;
  if (!classesOf[result.outcome].includes(repairClass)) {
    throw invalidResult(`${result.outcome} does not take class ${kind}`, finalMessage);
  }
  if (context.guard && (result.outcome === "RERUN" || result.outcome === "AMEND")) {
    throw invalidResult(
      `${result.outcome} is not accepted: this cause already received an automatic step`,
      finalMessage,
    );
  }
  const summary = textField(result, "summary", finalMessage);
  if (/[\r\n]/.test(summary.trim())) {
    throw invalidResult("summary must be one line", finalMessage);
  }
  const shared: RepairBase = {
    class: repairClass,
    summary: summary.trim(),
    evidence: strings(result, "evidence", finalMessage, false),
  };
  switch (result.outcome) {
    case "RERUN":
      return { ...shared, outcome: "RERUN" };
    case "AMEND":
      return { ...shared, ...parseAmend(result, context, finalMessage) };
    case "DECIDE":
      return {
        ...shared,
        outcome: "DECIDE",
        options: parseOptions(result, finalMessage),
      };
    default:
      return { ...shared, ...parseFollowUp(result, repairClass, finalMessage) };
  }
}
