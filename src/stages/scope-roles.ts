import { isRecord, type JsonRecord } from "../agent/json.ts";
import { hasOriginLine } from "../github/index.ts";
import type { StageRole } from "./prompt.ts";
import { invalidResult, parseAgentResult, resultFormat, textField } from "./result.ts";

const disclosureNote =
  "The stage posts `reason` on the request as written, so it must be safe at the " +
  "request repository's visibility (see the Visibility section). When the request " +
  "repository is public, or the material comes from a different private or internal " +
  "repository, the reason names no private source excerpts, private Issue text, " +
  "internal logs or secrets from that repository; it may say in general terms that a " +
  "private repository blocks the judgment, and why. An `internal` repository counts " +
  "as private.";

export const investigationRole: StageRole = {
  name: "scope-investigation",
  title: "Investigation",
  skill: "shape",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "feasible", "reason": "<the judgment, the owning repository, the ' +
        "affected surface, the request's own Issues and their state>\", " +
        '"repositories": ["<owner>/<repo> of each repository the work touches"]}',
      '{"outcome": "already-covered", "reason": "<the reason and evidence>", ' +
        '"covering": "<the URL of the covering Issue>" | null}',
      '{"outcome": "not-feasible", "reason": "<what is missing>"}',
      '{"outcome": "needs-person", "reason": "<the clause, decision or Issue only a ' +
        'person can settle, and why>"}',
    ],
    `${disclosureNote} Give \`covering\` only for an Issue; cite code, tests and ` +
      "pull requests in `reason`.",
  ),
};

export const planRole: StageRole = {
  name: "scope-plan",
  title: "Plan",
  skill: "scope",
  readOnly: true,
  resultFormat: resultFormat(
    [
      '{"outcome": "PLAN_READY", "deduplication": "verified" | "unverified", ' +
        '"report": "<the Plan output, Markdown>", "issues": [' +
        '{"key": "<a short unique key>", "repository": "<owner>/<repo>", ' +
        '"title": "<title>", "body": "<body, with the origin line>", ' +
        '"blockedBy": ["<key or Issue URL>"]}, ' +
        '{"key": "<a short unique key>", "reuse": "<URL of one of the request\'s own ' +
        'Issues>", "blockedBy": ["<key or Issue URL>"]}]}',
      '{"outcome": "PLAN_BLOCKED", "reason": "<the gap and evidence>"}',
      '{"outcome": "AUTHORITY_UPDATE_REQUIRED", "reason": "<the decision that must ' +
        'change>"}',
    ],
    `${disclosureNote} With unverified deduplication the stage posts \`report\` on ` +
      "the request the same way, so the same rule applies to it. Each new Issue's " +
      "title and body must be safe at its target " +
      "repository's visibility by the same rule. Every new Issue is in a repository " +
      "with an inventory section, and its body has the line `Origin: <request URL>` " +
      "as plain text. `reuse` names only one of the request's own Issues listed " +
      "above. `blockedBy` names keys of this list or existing Issue URLs, with no " +
      "cycle among keys.",
  ),
};

export type InvestigationResult =
  | { outcome: "feasible"; reason: string; repositories: string[] }
  | { outcome: "already-covered"; reason: string; covering: string | null }
  | { outcome: "not-feasible" | "needs-person"; reason: string };

/** An Issue the Plan creates. */
export interface PlannedNewIssue {
  key: string;
  repository: string;
  title: string;
  body: string;
  /** Keys of this plan or existing Issue URLs. */
  blockedBy: string[];
}

/** One of the request's own Issues the Plan keeps, with its body unchanged. */
export interface PlannedReuse {
  key: string;
  reuse: string;
  blockedBy: string[];
}

export type PlannedIssue = PlannedNewIssue | PlannedReuse;

export type PlanResult =
  | {
      outcome: "PLAN_READY";
      deduplication: "verified" | "unverified";
      report: string;
      issues: PlannedIssue[];
    }
  | { outcome: "PLAN_BLOCKED" | "AUTHORITY_UPDATE_REQUIRED"; reason: string };

/**
 * The plan the stage hands to publication (#736) in its own memory: approved by the
 * stage-supplied feasible judgment and a verified `PLAN_READY` for this request, never
 * by Issue text or comments (Proposal R3.7).
 */
export interface RequestPlan {
  /** The request's URL. */
  request: string;
  /** The feasible judgment's reason. */
  investigation: string;
  report: string;
  issues: PlannedIssue[];
}

const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const issueUrlPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/;

export function isIssueUrl(value: string): boolean {
  return issueUrlPattern.test(value);
}

export function parseInvestigationResult(finalMessage: string): InvestigationResult {
  const outcomes = [
    "feasible",
    "already-covered",
    "not-feasible",
    "needs-person",
  ] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  const reason = textField(result, "reason", finalMessage);
  switch (result.outcome) {
    case "feasible": {
      const { repositories } = result;
      const valid =
        Array.isArray(repositories) &&
        repositories.length > 0 &&
        repositories.every(
          (item) => typeof item === "string" && repositoryPattern.test(item),
        );
      if (!valid) {
        const why = "repositories must be a non-empty list of owner/repo names";
        throw invalidResult(why, finalMessage);
      }
      const unique = [...new Set(repositories as string[])];
      return { outcome: "feasible", reason, repositories: unique };
    }
    case "already-covered": {
      const { covering } = result;
      if (covering !== null && (typeof covering !== "string" || !isIssueUrl(covering))) {
        throw invalidResult("covering must be an Issue URL or null", finalMessage);
      }
      return { outcome: "already-covered", reason, covering };
    }
    default:
      return { outcome: result.outcome, reason };
  }
}

/** What the stage read, which a plan may refer to. */
export interface PlanContext {
  requestUrl: string;
  /** `owner/repo` of each repository the stage read an inventory for. */
  repositories: ReadonlySet<string>;
  /** The URLs of the request's own Issues. */
  originUrls: ReadonlySet<string>;
}

function entryText(
  entry: JsonRecord,
  field: string,
  where: string,
  finalMessage: string,
): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidResult(`${where}: ${field} must be a non-empty string`, finalMessage);
  }
  return value;
}

function parseEntry(
  value: unknown,
  index: number,
  context: PlanContext,
  finalMessage: string,
): PlannedIssue {
  if (!isRecord(value)) {
    throw invalidResult(`issues[${index}] must be an object`, finalMessage);
  }
  const key = entryText(value, "key", `issues[${index}]`, finalMessage);
  const where = `issue ${JSON.stringify(key)}`;
  const { blockedBy } = value;
  if (!Array.isArray(blockedBy) || !blockedBy.every((item) => typeof item === "string")) {
    throw invalidResult(`${where}: blockedBy must be a list of strings`, finalMessage);
  }
  const edges = blockedBy;
  if ("reuse" in value) {
    const reuse = entryText(value, "reuse", where, finalMessage);
    if (!context.originUrls.has(reuse)) {
      const why = `${where}: reuse ${reuse} is not one of the request's own Issues`;
      throw invalidResult(why, finalMessage);
    }
    return { key, reuse, blockedBy: edges };
  }
  const repository = entryText(value, "repository", where, finalMessage);
  if (!context.repositories.has(repository)) {
    const why = `${where}: the stage read no inventory of ${repository}`;
    throw invalidResult(why, finalMessage);
  }
  const title = entryText(value, "title", where, finalMessage);
  const body = entryText(value, "body", where, finalMessage);
  if (!hasOriginLine(body, context.requestUrl)) {
    const why = `${where}: the body lacks the line Origin: ${context.requestUrl}`;
    throw invalidResult(why, finalMessage);
  }
  return { key, repository, title, body, blockedBy: edges };
}

/** Rejects unknown edge targets, self-edges and cycles among keys. */
function checkEdges(issues: readonly PlannedIssue[], finalMessage: string): void {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  for (const issue of issues) {
    const where = `issue ${JSON.stringify(issue.key)}`;
    for (const target of issue.blockedBy) {
      if (!byKey.has(target) && !isIssueUrl(target)) {
        const why = `${where}: blockedBy ${target} is neither a key nor an Issue URL`;
        throw invalidResult(why, finalMessage);
      }
      if (target === issue.key || ("reuse" in issue && target === issue.reuse)) {
        throw invalidResult(`${where} is blocked by itself`, finalMessage);
      }
    }
  }
  const done = new Set<string>();
  const visit = (issue: PlannedIssue, path: readonly string[]): void => {
    const { key } = issue;
    if (path.includes(key)) {
      const cycle = [...path.slice(path.indexOf(key)), key].join(" -> ");
      throw invalidResult(`blockedBy has a cycle: ${cycle}`, finalMessage);
    }
    if (done.has(key)) {
      return;
    }
    for (const target of issue.blockedBy) {
      const blocker = byKey.get(target);
      if (blocker !== undefined) {
        visit(blocker, [...path, key]);
      }
    }
    done.add(key);
  };
  for (const issue of issues) {
    visit(issue, []);
  }
}
export function parsePlanResult(finalMessage: string, context: PlanContext): PlanResult {
  const outcomes = ["PLAN_READY", "PLAN_BLOCKED", "AUTHORITY_UPDATE_REQUIRED"] as const;
  const result = parseAgentResult(finalMessage, outcomes);
  if (result.outcome !== "PLAN_READY") {
    return { outcome: result.outcome, reason: textField(result, "reason", finalMessage) };
  }
  const { deduplication } = result;
  if (deduplication !== "verified" && deduplication !== "unverified") {
    const why = 'deduplication must be "verified" or "unverified"';
    throw invalidResult(why, finalMessage);
  }
  const report = textField(result, "report", finalMessage);
  const { issues } = result;
  if (!Array.isArray(issues) || issues.length === 0) {
    throw invalidResult("issues must be a non-empty list", finalMessage);
  }
  const parsed = issues.map((entry, index) =>
    parseEntry(entry, index, context, finalMessage),
  );
  const keys = new Set<string>();
  const reused = new Set<string>();
  for (const issue of parsed) {
    if (keys.has(issue.key)) {
      throw invalidResult(`key ${JSON.stringify(issue.key)} is duplicated`, finalMessage);
    }
    keys.add(issue.key);
    if ("reuse" in issue) {
      if (reused.has(issue.reuse)) {
        throw invalidResult(`${issue.reuse} is reused twice`, finalMessage);
      }
      reused.add(issue.reuse);
    }
  }
  checkEdges(parsed, finalMessage);
  return { outcome: "PLAN_READY", deduplication, report, issues: parsed };
}
