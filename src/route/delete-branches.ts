import {
  type ActingClient,
  deleteBranch,
  readIssueBranches,
  type Repo,
} from "../github/index.ts";

/**
 * Deletes the branches of Issue `issue` whose ref exists: `nibfin/issue-<n>` and every
 * `nibfin/issue-<n>-cd-<k>` that `readIssueBranches` probes (#700). Nothing else is
 * touched. Deleting a branch also closes its open pull request.
 */
export async function deleteIssueBranches(
  client: ActingClient,
  repo: Repo,
  issue: number,
  log: (line: string) => void,
): Promise<void> {
  const branches = await readIssueBranches(client, repo, issue);
  for (const probe of [branches.delivery, ...branches.fixes]) {
    if (probe.exists) {
      await deleteBranch(client, repo, probe.name);
      log(`${repo.owner}/${repo.repo}#${issue}: deleted branch ${probe.name}`);
    }
  }
}
