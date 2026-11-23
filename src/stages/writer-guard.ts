import { type GitHubClient, GitHubError, type Repo } from "../github/index.ts";
import type { JobContext } from "./context.ts";
import { StageError } from "./errors.ts";

/** The run name #674 gives every Deliver Job of an Issue. */
export function deliverRunName(repo: Repo, issue: number): string {
  return `Nibfin · ${repo.owner}/${repo.repo}#${issue} · deliver`;
}

function missing(field: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", `${field} is missing`);
}

/**
 * Confirms no other Deliver Job of the Issue is running, so a redo starts only after
 * the previous Writer stopped. GitHub has no query for a concurrency holder, so this
 * lists the in-progress workflow runs of the execution repository (all workflows,
 * every page) other than this Job's run, and matches the run name. Another match is
 * `STAGE_WRITER_ACTIVE`: the outcome is Pending and nothing is written.
 */
export async function requireNoOtherWriter(
  client: GitHubClient,
  context: JobContext,
): Promise<void> {
  const { runRepo, runId } = context;
  if (runRepo === undefined) {
    throw missing("NIBFIN_RUN_REPO");
  }
  if (runId === undefined) {
    throw missing("NIBFIN_RUN_ID");
  }
  const where = `${runRepo.owner}/${runRepo.repo}`;
  let runs;
  try {
    runs = await client.paginate("GET /repos/{owner}/{repo}/actions/runs", {
      ...runRepo,
      status: "in_progress",
      per_page: 100,
    });
  } catch (error) {
    throw new GitHubError("GITHUB_READ_FAILED", `read runs of ${where}`, error);
  }
  const name = deliverRunName(context.repo, context.issue);
  const other = runs.find(
    (run) =>
      run.id !== runId &&
      run.status === "in_progress" &&
      (run.display_title === name || run.name === name),
  );
  if (other !== undefined) {
    const message =
      `Another Deliver Job of this Issue is still running (${other.html_url}); ` +
      "the redo waits until it stops.";
    throw new StageError("STAGE_WRITER_ACTIVE", message);
  }
}
