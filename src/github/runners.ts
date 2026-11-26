import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";

/**
 * The self-hosted runner label of an Assignee (#720): the one place it is formed.
 * Route dispatches a stage to an Assignee only when a runner of the execution
 * repository has it.
 */
export const runnerLabel = (assignee: number) => `nibfin-${assignee}`;

/** One self-hosted runner as routing sees it. */
export interface RunnerLabels {
  /** Whether GitHub reports its `status` as `online`; a busy runner is online. */
  online: boolean;
  /** Its label names, lowercased, since runner labels are case-insensitive. */
  labels: Set<string>;
}

/**
 * Every self-hosted runner of `repo` (all pages) with whether it is online and its
 * lowercased labels (#739). Only a `status` of `online` (case-insensitive) counts
 * as online; anything else counts as offline. `busy` is not read. Listing needs
 * admin access to `repo`.
 */
export async function readRunners(
  client: GitHubClient,
  repo: Repo,
): Promise<RunnerLabels[]> {
  const runners = await read(`list runners of ${repo.owner}/${repo.repo}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/actions/runners", {
      ...repo,
      per_page: 100,
    }),
  );
  return runners.map((runner) => ({
    online: runner.status.toLowerCase() === "online",
    labels: new Set(runner.labels.map((label) => label.name.toLowerCase())),
  }));
}
