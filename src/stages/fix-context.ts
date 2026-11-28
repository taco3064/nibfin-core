import {
  type GitHubClient,
  readJobLog,
  readRunJobs,
  type Repo,
  type RequiredCheckResult,
  type WorkflowRunSummary,
} from "../github/index.ts";
import { describeNewBaseCommits, rebaseInstructions } from "./base-moved.ts";
import type { FixPointer } from "./deliver-eligibility.ts";
import type { Git } from "./git.ts";
import { fenced } from "./prompt.ts";

/** How many trailing lines of a failed job's log an excerpt always keeps. */
export const logTailLines = 200;

/** Lines of context kept before and after each failure marker line. */
export const failureContextLines = 5;

/** How many lines before the tail an excerpt may spend on failure sections. */
export const failureSectionLines = 200;

/**
 * Substrings that mark a failing line anywhere in a job log line (GitHub prefixes
 * each line with a timestamp, so they are not anchored).
 */
export const failureMarkers: readonly string[] = [
  "--- FAIL",
  "panic:",
  "fatal error:",
  "Exception 0x",
  "##[error]",
];

/** A half-open range `[start, end)` of 0-based log line indexes. */
interface LineRange {
  start: number;
  end: number;
}

/** The merged ranges around failure markers in `lines[0, before)`. */
function failureSections(lines: readonly string[], before: number): LineRange[] {
  const sections: LineRange[] = [];
  for (let index = 0; index < before; index++) {
    if (!failureMarkers.some((marker) => lines[index].includes(marker))) {
      continue;
    }
    const start = Math.max(0, index - failureContextLines);
    const end = Math.min(before, index + failureContextLines + 1);
    const last = sections.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = end;
    } else {
      sections.push({ start, end });
    }
  }
  return sections;
}

/**
 * The excerpt of an already redacted job log: every failing section before the last
 * `logTailLines` lines, with `failureContextLines` lines of context, in log order and
 * merged where they overlap or touch, within `failureSectionLines` lines, then the
 * tail. Each part is labelled with its line range; when lines were left out, a note
 * says which and that the full log is at `url`.
 */
export function logExcerpt(log: string, url: string | null | undefined): string {
  const lines = log.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const total = lines.length;
  if (total === 0) {
    return "Job log excerpt (0 lines): the job log is empty.";
  }
  const tailStart = Math.max(0, total - logTailLines);
  const parts: LineRange[] = [];
  let budget = failureSectionLines;
  let leftSections = 0;
  let leftFrom: number | undefined;
  for (const section of failureSections(lines, tailStart)) {
    const length = section.end - section.start;
    const kept = Math.min(length, budget);
    if (kept > 0) {
      parts.push({ start: section.start, end: section.start + kept });
      budget -= kept;
    }
    if (kept < length) {
      leftSections++;
      leftFrom ??= section.start + kept;
    }
  }
  parts.push({ start: tailStart, end: total });
  const merged: LineRange[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last !== undefined && part.start <= last.end) {
      last.end = part.end;
    } else {
      merged.push({ ...part });
    }
  }
  const shown = merged.reduce((sum, part) => sum + part.end - part.start, 0);
  const out = [`Job log excerpt (${shown} of ${total} lines):`];
  for (const part of merged) {
    out.push(
      `Lines ${part.start + 1}–${part.end}:`,
      fenced(lines.slice(part.start, part.end).join("\n")),
    );
  }
  if (shown < total) {
    const note = [
      `Left out: ${total - shown} lines outside the shown ranges.`,
      ...(leftFrom === undefined
        ? []
        : [
            `${leftSections} failure section(s) were left out or cut by the ` +
              `${failureSectionLines}-line bound, from line ${leftFrom + 1}.`,
          ]),
      `The full log is at ${url ?? "the job's page on GitHub"}.`,
    ];
    out.push(note.join(" "));
  }
  return out.join("\n\n");
}

export interface FixContextOptions {
  client: GitHubClient;
  repo: Repo;
  /** Removes the token from log text. */
  redact: (text: string) => string;
  /** The workspace, with the branch checked out and `origin/<base>` fetched. */
  git: Git;
  base: string;
}

/**
 * The failure-aware excerpt (`logExcerpt`) of GitHub Actions job `jobId`'s log, at
 * `url`, redacted as a whole before it is searched or cut, or a note that the log is
 * not available.
 */
export async function jobLogExcerpt(
  client: GitHubClient,
  repo: Repo,
  redact: (text: string) => string,
  jobId: number,
  url: string | null | undefined,
): Promise<string> {
  const log = await readJobLog(client, repo, jobId);
  if (log === undefined) {
    return "The job log is not available.";
  }
  return logExcerpt(redact(log), url);
}

function logExcerptOf(
  options: FixContextOptions,
  jobId: number,
  url: string | null | undefined,
): Promise<string> {
  return jobLogExcerpt(options.client, options.repo, options.redact, jobId, url);
}

async function describeCheck(
  options: FixContextOptions,
  result: RequiredCheckResult,
): Promise<string> {
  const lines = [`### ${result.context}`, "", `URL: ${result.url ?? "(none)"}`, ""];
  const actionsJob =
    result.source === "check-run" &&
    result.appSlug === "github-actions" &&
    result.checkRunId !== undefined;
  if (actionsJob) {
    lines.push(await logExcerptOf(options, result.checkRunId!, result.url));
  } else {
    lines.push("Not a GitHub Actions job: read the result at its URL.");
  }
  return lines.join("\n");
}

async function describeRun(
  options: FixContextOptions,
  run: WorkflowRunSummary,
): Promise<string> {
  const parts = [`### ${run.name} (${run.path})`, "", `URL: ${run.url}`];
  const jobs = await readRunJobs(options.client, options.repo, run.id);
  for (const job of jobs.filter((candidate) => candidate.state === "failed")) {
    parts.push("", `#### Job ${job.name}`, "", `URL: ${job.url ?? "(none)"}`, "");
    parts.push(await logExcerptOf(options, job.id, job.url));
  }
  return parts.join("\n");
}

/**
 * The fix reason and what it points at, as the Writer and the Acceptor read it:
 * `ci-failure` → the failed required checks with URLs, and the log excerpt of each
 * GitHub Actions job (other checks and statuses: URL only); `review` → the review
 * comment; `cd-failure` → the failed CD runs that decided the fix (the Issue's own
 * merge, or another Issue's fix on a newer base head, #772), their merged PR and
 * merge commit, with the log excerpts of their failed jobs; `conflict` → the PR, what
 * to do, and the commits of the base the branch lacks with their pull requests. Log
 * text is redacted of the token. A log excerpt keeps the tail and every earlier
 * failing section (`logExcerpt`).
 */
export async function describeFix(
  options: FixContextOptions,
  fix: FixPointer,
): Promise<string> {
  const parts = [`Reason: ${fix.reason}`];
  if (fix.reason === "ci-failure") {
    parts.push(`Pull request: ${fix.pullRequest.url}`, "Failed required checks:");
    for (const result of fix.failed) {
      parts.push(await describeCheck(options, result));
    }
  } else if (fix.reason === "conflict") {
    parts.push(
      `Pull request: ${fix.pullRequest.url}`,
      `It conflicts with \`${options.base}\`. ${rebaseInstructions(options.base)}`,
      await describeNewBaseCommits(options),
    );
  } else if (fix.reason === "review") {
    parts.push(
      `Pull request: ${fix.pullRequest.url}`,
      `Review comment: ${fix.comment.url}`,
      fenced(options.redact(fix.comment.body)),
    );
  } else if (fix.failedOn === undefined) {
    parts.push("No merged pull request with a failed CD run was found.");
  } else {
    const { mergeCommitSha, pullRequestUrl } = fix.failedOn;
    parts.push(
      `Merged pull request: ${pullRequestUrl}`,
      `Merge commit: \`${mergeCommitSha}\``,
      "Failed CD runs:",
    );
    for (const run of fix.failed) {
      parts.push(await describeRun(options, run));
    }
  }
  return parts.join("\n\n");
}
