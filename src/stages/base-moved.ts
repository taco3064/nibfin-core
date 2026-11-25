import { type GitHubClient, readCommitPullRequests, type Repo } from "../github/index.ts";
import { type Git, newBaseCommits } from "./git.ts";

/** How many new base commits the Writer gets listed. */
export const baseCommitLimit = 50;

/** Where the new base commits are read: the workspace and the repository on GitHub. */
export interface BaseScope {
  git: Git;
  client: GitHubClient;
  repo: Repo;
  base: string;
}

/** What the Writer does when the branch lacks commits of the base. */
export function rebaseInstructions(base: string): string {
  return (
    `Rebase the branch onto \`refs/remotes/origin/${base}\` (already fetched; you ` +
    "cannot fetch it yourself), resolve any conflict keeping the work the new base " +
    "commits delivered, and rerun the checks the rebased changes affect."
  );
}

/**
 * The commits of `origin/<base>` that `HEAD` lacks (`%h %s`, newest first, at most
 * `baseCommitLimit` and a count of the rest), each with the pull requests GitHub
 * associates with it. A failed read is `GITHUB_READ_FAILED`.
 */
export async function describeNewBaseCommits(scope: BaseScope): Promise<string> {
  const { git, client, repo, base } = scope;
  const { commits, more } = await newBaseCommits(git, base, baseCommitLimit);
  const lines = [`Commits on \`${base}\` that the branch does not have:`, ""];
  for (const commit of commits) {
    const pulls = await readCommitPullRequests(client, repo, commit.sha);
    const listed = pulls.map((pull) => `#${pull.number} ${pull.title} (${pull.url})`);
    const from = listed.length === 0 ? "no pull request" : listed.join("; ");
    lines.push(`- ${commit.line} (${from})`);
  }
  if (more > 0) {
    lines.push(`- and ${more} more`);
  }
  return lines.join("\n");
}

/** The defect for the Writer when `origin/<base>` moved to `head` during the run. */
export async function baseMovedDefect(scope: BaseScope, head: string): Promise<string> {
  return [
    `The base branch \`${scope.base}\` moved to ${head} while this delivery ran. ` +
      rebaseInstructions(scope.base),
    "",
    await describeNewBaseCommits(scope),
  ].join("\n");
}
