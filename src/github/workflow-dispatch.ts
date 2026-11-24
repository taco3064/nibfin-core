import type { GitHubClient } from "./client.ts";
import { GitHubError, isUnknownOutcome, read } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** The run statuses of a workflow run that has not started (#674). */
export const notStartedStatuses = ["requested", "waiting", "pending", "queued"] as const;

export interface QueuedRun {
  id: number;
  /** The run name (`display_title`). */
  title: string;
}

/**
 * The workflow runs of `repo` that have not started yet: one list request (all
 * pages) per status in `notStartedStatuses`, since the API takes one status at a
 * time.
 */
export async function readNotStartedRuns(
  client: GitHubClient,
  repo: Repo,
): Promise<QueuedRun[]> {
  const runs: QueuedRun[] = [];
  for (const status of notStartedStatuses) {
    const page = await read(`list ${status} runs of ${repo.owner}/${repo.repo}`, () =>
      client.paginate("GET /repos/{owner}/{repo}/actions/runs", {
        ...repo,
        status,
        per_page: 100,
      }),
    );
    runs.push(...page.map((run) => ({ id: run.id, title: run.display_title })));
  }
  return runs;
}

/** The default branch of `repo`. */
export async function readDefaultBranch(client: GitHubClient, repo: Repo) {
  const { data } = await read(`read ${repo.owner}/${repo.repo}`, () =>
    client.request("GET /repos/{owner}/{repo}", { ...repo }),
  );
  return data.default_branch;
}

/**
 * Dispatches `workflow` of `repo` on its default branch with `inputs` and returns
 * the new run's URL when GitHub reports it. A dispatch cannot be confirmed by a
 * re-read: no response or a 5xx is `GITHUB_WRITE_UNCONFIRMED`, any other failure
 * `GITHUB_WRITE_REJECTED`.
 */
export async function dispatchWorkflow(
  client: GitHubClient,
  repo: Repo,
  workflow: string,
  inputs: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const ref = await readDefaultBranch(client, repo);
  const operation = `dispatch ${workflow} of ${repo.owner}/${repo.repo}`;
  try {
    const { data } = await client.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      { ...repo, workflow_id: workflow, ref, inputs, return_run_details: true },
    );
    return (data as { html_url?: string } | undefined)?.html_url;
  } catch (error) {
    const code = isUnknownOutcome(error)
      ? "GITHUB_WRITE_UNCONFIRMED"
      : "GITHUB_WRITE_REJECTED";
    throw new GitHubError(code, operation, error);
  }
}
