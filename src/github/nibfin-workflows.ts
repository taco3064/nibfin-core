import type { Repo } from "./repo.ts";

/** Every workflow Nibfin installs has a name starting with this prefix. */
export const nibfinWorkflowPrefix = "Nibfin ·";

/** True for a workflow (or workflow run) name that belongs to Nibfin itself. */
export function isNibfinWorkflow(name: string | null | undefined): boolean {
  return typeof name === "string" && name.startsWith(nibfinWorkflowPrefix);
}

/**
 * The run name of an Issue's stage or route run (#674):
 * `Nibfin · <owner>/<repo>#<n> · <stage>`.
 */
export function nibfinRunTitle(repo: Repo, issue: number, stage: string): string {
  return `${nibfinWorkflowPrefix} ${repo.owner}/${repo.repo}#${issue} · ${stage}`;
}
