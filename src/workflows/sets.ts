/**
 * The execution set is the execution repository's, which runs every Job; the peer set
 * is that of a repository whose events wake the execution repository.
 */
export const workflowSets = ["execution", "peer"] as const;
export type WorkflowSet = (typeof workflowSets)[number];

/**
 * `own`: Nibfin's own repositories, which call Core `@main` and pull the `:main` image.
 * `user`: what `gh nibfin init` and `upgrade` write, self-contained with the image
 * pinned by digest.
 */
export const workflowChannels = ["own", "user"] as const;
export type WorkflowChannel = (typeof workflowChannels)[number];

/** Where the rendered files go in a repository. */
export const workflowDir = ".github/workflows";

const files: Record<WorkflowChannel, Record<WorkflowSet, readonly string[]>> = {
  own: {
    execution: [
      "nibfin-issue.yml",
      "nibfin-events.yml",
      "nibfin-shared-runner.yml",
      "nibfin-job.yml",
      "nibfin-runner-request.yml",
      "nibfin-e2e-notify.yml",
    ],
    peer: ["nibfin-issue.yml", "nibfin-e2e-notify.yml"],
  },
  user: {
    execution: [
      "nibfin-issue.yml",
      "nibfin-shared-runner.yml",
      "nibfin-job.yml",
      "nibfin-runner-request.yml",
    ],
    peer: ["nibfin-issue.yml"],
  },
};

/** The file names of a set in a channel, sorted. */
export function workflowFiles(set: WorkflowSet, channel: WorkflowChannel): string[] {
  return [...files[channel][set]].sort();
}
