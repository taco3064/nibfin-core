import type { GitHubClient } from "./client.ts";
import { absentProbe, read, readOptional } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { type RunState, runState } from "./run-state.ts";
import { write } from "./write.ts";

/** A job of a GitHub Actions workflow run. */
export interface WorkflowJobSummary {
  id: number;
  name: string;
  state: RunState;
  url: string | null;
}

/** The jobs of the latest attempt of workflow run `runId` (`filter=latest`). */
export async function readRunJobs(
  client: GitHubClient,
  repo: Repo,
  runId: number,
): Promise<WorkflowJobSummary[]> {
  const where = `${repo.owner}/${repo.repo} run ${runId}`;
  const jobs = await read(`read jobs of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      ...repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
    }),
  );
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    state: runState(job.status, job.conclusion),
    url: job.html_url,
  }));
}

/**
 * The log text of GitHub Actions job `jobId` (for a check run created by GitHub
 * Actions, its id). GitHub answers with a redirect to the log, which the client
 * follows. `undefined` when GitHub has no log for the job (404).
 */
export async function readJobLog(
  client: GitHubClient,
  repo: Repo,
  jobId: number,
): Promise<string | undefined> {
  const where = `${repo.owner}/${repo.repo} job ${jobId}`;
  const response = await readOptional(`read log of ${where}`, () =>
    client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
      ...repo,
      job_id: jobId,
      request: absentProbe,
    }),
  );
  if (response === undefined) {
    return undefined;
  }
  const data: unknown = response.data;
  if (typeof data === "string") {
    return data;
  }
  return new TextDecoder().decode(data as ArrayBuffer);
}

/**
 * Re-runs GitHub Actions job `jobId` and the jobs that depend on it
 * (`POST …/actions/jobs/{job_id}/rerun`, 201). A re-run cannot be confirmed by a
 * re-read before GitHub starts it, so a failure is re-sent without a pre-read up to
 * `maxRetries` times, as a dispatch is.
 */
export async function rerunJob(
  client: GitHubClient,
  repo: Repo,
  jobId: number,
): Promise<void> {
  await write(
    client,
    `re-run ${repo.owner}/${repo.repo} job ${jobId}`,
    async () => {
      await client.request("POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun", {
        ...repo,
        job_id: jobId,
      });
      return true;
    },
    { confirm: () => Promise.resolve(undefined) },
  );
}
