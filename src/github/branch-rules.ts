import type { GitHubClient } from "./client.ts";
import { GitHubError, read, responseMessage, statusOf } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** One rule of `GET /repos/{owner}/{repo}/rules/branches/{branch}`. */
export type BranchRule = Awaited<ReturnType<typeof listRules>>[number];

function listRules(client: GitHubClient, repo: Repo, branch: string) {
  return client.paginate("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
    ...repo,
    branch,
    per_page: 100,
  });
}

/**
 * The ruleset rules that apply to `branch`. A private repository on a plan without
 * rulesets answers 403 "Upgrade to GitHub Pro or make this repository public": no
 * ruleset can apply there, so that answer reads as no rules. Any other failure is
 * `GITHUB_READ_FAILED`.
 */
export async function readBranchRules(
  client: GitHubClient,
  repo: Repo,
  branch: string,
): Promise<BranchRule[]> {
  const where = `${repo.owner}/${repo.repo}@${branch}`;
  try {
    return await read(`read rules of ${where}`, () => listRules(client, repo, branch));
  } catch (error) {
    if (error instanceof GitHubError && isPlanWithoutRulesets(error.cause)) {
      return [];
    }
    throw error;
  }
}

const planMessage = /\bupgrade to github pro\b|\bmake this repository public\b/i;

/** GitHub's 403 for a feature the repository's plan does not include. */
function isPlanWithoutRulesets(error: unknown): boolean {
  const message = responseMessage(error);
  return statusOf(error) === 403 && message !== undefined && planMessage.test(message);
}
