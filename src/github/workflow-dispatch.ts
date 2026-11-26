import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { write } from "./write.ts";

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

/** `GET /repos/{owner}/{repo}`; within a run the read cache shares one request. */
async function readRepo(client: GitHubClient, repo: Repo) {
  const { data } = await read(`read ${repo.owner}/${repo.repo}`, () =>
    client.request("GET /repos/{owner}/{repo}", { ...repo }),
  );
  return data;
}

/** The default branch of `repo`. */
export async function readDefaultBranch(client: GitHubClient, repo: Repo) {
  return (await readRepo(client, repo)).default_branch;
}

/** The user id of `repo`'s owner (`owner.id`; an organisation's id when it owns it). */
export async function readRepoOwnerId(client: GitHubClient, repo: Repo): Promise<number> {
  return Number((await readRepo(client, repo)).owner.id);
}

/**
 * Dispatches `workflow` of `repo` on its default branch with `inputs` and returns
 * the new run's URL when GitHub reports it. A dispatch only wakes an Issue, so a
 * repeated one is harmless (R4.35), and it cannot be confirmed by a re-read: any
 * failure is re-sent without a pre-read up to `maxRetries` times. Then no response
 * or a 5xx is `GITHUB_WRITE_UNCONFIRMED`, any other failure `GITHUB_WRITE_REJECTED`.
 */
export async function dispatchWorkflow(
  client: GitHubClient,
  repo: Repo,
  workflow: string,
  inputs: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const ref = await readDefaultBranch(client, repo);
  return write(
    client,
    `dispatch ${workflow} of ${repo.owner}/${repo.repo}`,
    async () => {
      const { data } = await client.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        { ...repo, workflow_id: workflow, ref, inputs, return_run_details: true },
      );
      return (data as { html_url?: string } | undefined)?.html_url;
    },
    { confirm: () => Promise.resolve(undefined) },
  );
}
