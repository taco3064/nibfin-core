import { type PullRequestSummary, summarizePullRequest } from "./branches.ts";
import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** A pull request with GitHub's view of whether it can be merged. */
export interface PullRequestDetail extends PullRequestSummary {
  /** `null` while GitHub computes it in the background. */
  mergeable: boolean | null;
  /** Such as `clean`, `blocked`, `behind`, `dirty`, `unstable` or `unknown`. */
  mergeableState: string;
}

/** One pull request by number, with `mergeable` and `mergeable_state`. */
export async function readPullRequest(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<PullRequestDetail> {
  const { data } = await read(
    `read pull request ${repo.owner}/${repo.repo}#${number}`,
    () =>
      client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...repo,
        pull_number: number,
      }),
  );
  return {
    ...summarizePullRequest(data),
    mergeable: data.mergeable,
    mergeableState: data.mergeable_state,
  };
}

/** The SHAs of a pull request's current commits, oldest first. */
export async function readPullRequestCommits(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<string[]> {
  const commits = await read(
    `list commits of pull request ${repo.owner}/${repo.repo}#${number}`,
    () =>
      client.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
        ...repo,
        pull_number: number,
        per_page: 100,
      }),
  );
  return commits.map((commit) => commit.sha);
}

/**
 * How many reviewers approved: each reviewer's latest approving, dismissed or
 * change-requesting review counts, plain comments do not.
 */
export async function readApprovalCount(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<number> {
  const reviews = await read(
    `list reviews of pull request ${repo.owner}/${repo.repo}#${number}`,
    () =>
      client.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        ...repo,
        pull_number: number,
        per_page: 100,
      }),
  );
  const latest = new Map<number, string>();
  for (const review of reviews.toSorted((a, b) => a.id - b.id)) {
    if (review.user && review.state !== "COMMENTED") {
      latest.set(review.user.id, review.state);
    }
  }
  return [...latest.values()].filter((state) => state === "APPROVED").length;
}
