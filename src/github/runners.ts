import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";

/**
 * The self-hosted runner label of an Assignee (#720): the one place it is formed.
 * Route dispatches a stage only when a runner of the execution repository has it.
 */
export const runnerLabel = (assignee: number) => `nibfin-${assignee}`;

/**
 * The label names of every self-hosted runner of `repo` (all pages), lowercased,
 * since runner labels are case-insensitive. A runner counts whatever its `status`
 * or `busy` state. Listing needs admin access to `repo`.
 */
export async function readRunnerLabels(
  client: GitHubClient,
  repo: Repo,
): Promise<Set<string>> {
  const runners = await read(`list runners of ${repo.owner}/${repo.repo}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/actions/runners", {
      ...repo,
      per_page: 100,
    }),
  );
  return new Set(
    runners.flatMap((runner) => runner.labels.map((label) => label.name.toLowerCase())),
  );
}
