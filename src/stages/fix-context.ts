import {
  type GitHubClient,
  readJobLog,
  readRunJobs,
  type Repo,
  type RequiredCheckResult,
  type WorkflowRunSummary,
} from "../github/index.ts";
import type { FixPointer } from "./deliver-eligibility.ts";
import { fenced } from "./prompt.ts";

/** How many trailing lines of a failed job's log the Writer and Acceptor get. */
export const logTailLines = 200;

export interface FixContextOptions {
  client: GitHubClient;
  repo: Repo;
  /** Removes the token from log text. */
  redact: (text: string) => string;
}

async function logTail(options: FixContextOptions, jobId: number): Promise<string> {
  const log = await readJobLog(options.client, options.repo, jobId);
  if (log === undefined) {
    return "The job log is not available.";
  }
  const lines = options.redact(log).split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const tail = lines.slice(-logTailLines).join("\n");
  return `Last ${logTailLines} lines of the job log:\n\n${fenced(tail)}`;
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
    lines.push(await logTail(options, result.checkRunId!));
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
    parts.push(await logTail(options, job.id));
  }
  return parts.join("\n");
}

/**
 * The fix reason and what it points at, as the Writer and the Acceptor read it:
 * `ci-failure` → the failed required checks with URLs, and the log tail of each
 * GitHub Actions job (other checks and statuses: URL only); `review` → the review
 * comment; `cd-failure` → the failed CD runs of the merged PR with the log tails of
 * their failed jobs. Log text is redacted of the token.
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
  } else if (fix.reason === "review") {
    parts.push(
      `Pull request: ${fix.pullRequest.url}`,
      `Review comment: ${fix.comment.url}`,
      fenced(options.redact(fix.comment.body)),
    );
  } else if (fix.pullRequest === undefined) {
    parts.push("No merged pull request with a failed CD run was found.");
  } else {
    parts.push(`Merged pull request: ${fix.pullRequest.url}`, "Failed CD runs:");
    for (const run of fix.failed) {
      parts.push(await describeRun(options, run));
    }
  }
  return parts.join("\n\n");
}
