import { type PullRequestSummary, summarizePullRequest } from "./branches.ts";
import type { GitHubClient } from "./client.ts";
import { GitHubError, read, readOptional } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** A pull request with GitHub's view of whether it can be merged. */
export interface PullRequestDetail extends PullRequestSummary {
  /** `null` while GitHub computes it in the background. */
  mergeable: boolean | null;
  /** Such as `clean`, `blocked`, `behind`, `dirty`, `unstable` or `unknown`. */
  mergeableState: string;
  /** The commit the base branch pointed to when GitHub answered. */
  baseSha: string;
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
    baseSha: data.base.sha,
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

/** A reviewer's latest submitted review that approved, dismissed or requested changes. */
export interface LatestReview {
  id: number;
  login: string;
  /** Such as `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`. */
  state: string;
  /** The head the review was submitted on; `null` when GitHub has none. */
  commitId: string | null;
  url: string;
  /** The review's text; empty when it has none. */
  body: string;
}

/**
 * Each reviewer's latest review (all pages, ordered by id), one per user id: plain
 * comments, unsubmitted (`PENDING`) reviews and reviews without a user do not count.
 */
export async function readLatestReviews(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<LatestReview[]> {
  const reviews = await read(
    `list reviews of pull request ${repo.owner}/${repo.repo}#${number}`,
    () =>
      client.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        ...repo,
        pull_number: number,
        per_page: 100,
      }),
  );
  const latest = new Map<number, LatestReview>();
  for (const review of reviews.toSorted((a, b) => a.id - b.id)) {
    const { user, state } = review;
    if (user && state !== "COMMENTED" && state !== "PENDING") {
      latest.set(user.id, {
        id: review.id,
        login: user.login,
        state,
        commitId: review.commit_id ?? null,
        url: review.html_url,
        body: review.body ?? "",
      });
    }
  }
  return [...latest.values()];
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
  const reviews = await readLatestReviews(client, repo, number);
  return reviews.filter((review) => review.state === "APPROVED").length;
}

/** An inline comment of a review. */
export interface ReviewComment {
  path: string;
  /** `null` for a comment on a whole file or an outdated line. */
  line: number | null;
  body: string;
  url: string;
}

/** The inline comments of one review of a pull request (all pages). */
export async function readReviewComments(
  client: GitHubClient,
  repo: Repo,
  number: number,
  reviewId: number,
): Promise<ReviewComment[]> {
  const where = `${repo.owner}/${repo.repo}#${number}`;
  const comments = await read(`list comments of review ${reviewId} of ${where}`, () =>
    client.paginate(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
      { ...repo, pull_number: number, review_id: reviewId, per_page: 100 },
    ),
  );
  return comments.map((comment) => ({
    path: comment.path,
    line: comment.line ?? null,
    body: comment.body,
    url: comment.html_url,
  }));
}

/** The users (logins) and teams (slugs) a pull request still asks for a review. */
export interface RequestedReviewers {
  users: string[];
  teams: string[];
}

/** A pull request's requested reviewers; a submitted review removes its reviewer. */
export async function readRequestedReviewers(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<RequestedReviewers> {
  const { data } = await read(
    `read requested reviewers of ${repo.owner}/${repo.repo}#${number}`,
    () =>
      client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
        { ...repo, pull_number: number },
      ),
  );
  return {
    users: data.users.map((user) => user.login),
    teams: data.teams.map((team) => team.slug),
  };
}

/**
 * Whether `login` has write access to the repository: its collaborator permission is
 * `admin` or `write` (`maintain` reads as `write`). A 404 (not a collaborator) is no
 * access; any other failure is `GITHUB_READ_FAILED`.
 */
export async function hasWritePermission(
  client: GitHubClient,
  repo: Repo,
  login: string,
): Promise<boolean> {
  const answer = await readOptional(
    `read the permission of ${login} on ${repo.owner}/${repo.repo}`,
    () =>
      client.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        ...repo,
        username: login,
      }),
  );
  const permission = answer?.data.permission;
  return permission === "admin" || permission === "write";
}

const forcePushQuery = `query(
  $owner: String!
  $repo: String!
  $number: Int!
  $cursor: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(
        itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]
        first: 100
        after: $cursor
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } }
      }
    }
  }
}`;

interface ForcePushPage {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ beforeCommit?: { oid: string } | null } | null>;
        };
      } | null;
    } | null;
  };
  errors?: unknown[];
}

/**
 * The heads a pull request had right before each force push, from GraphQL
 * `HeadRefForcePushedEvent.beforeCommit`, all pages. A force push removes those heads
 * from the pull request's commit list; GitHub's timeline keeps them.
 */
export async function readForcePushedHeads(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<string[]> {
  const operation = `read force pushes of ${repo.owner}/${repo.repo}#${number}`;
  const heads: string[] = [];
  let cursor: string | null = null;
  do {
    const answer = await read(operation, () =>
      client.request("POST /graphql", {
        query: forcePushQuery,
        variables: { ...repo, number, cursor },
      }),
    );
    const page = (answer.data as ForcePushPage).data?.repository?.pullRequest;
    const items = page?.timelineItems;
    if ((answer.data as ForcePushPage).errors !== undefined || items === undefined) {
      const cause = new Error("GraphQL returned no timeline");
      throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
    }
    heads.push(...items.nodes.flatMap((node) => node?.beforeCommit?.oid ?? []));
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor !== null);
  return heads;
}

/**
 * The commits of `head` that `base` does not have (`GET …/compare/{base}...{head}`,
 * at most the 250 GitHub returns), or `undefined` when GitHub no longer has `head`.
 */
export async function readCommitsAhead(
  client: GitHubClient,
  repo: Repo,
  base: string,
  head: string,
): Promise<string[] | undefined> {
  const where = `${repo.owner}/${repo.repo} ${base}...${head}`;
  const answer = await readOptional(`compare ${where}`, () =>
    client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      ...repo,
      basehead: `${base}...${head}`,
    }),
  );
  return answer?.data.commits.map((commit) => commit.sha);
}

/** A pull request GitHub associates with a commit. */
export interface CommitPullRequest {
  number: number;
  title: string;
  url: string;
  /** The description; empty when it has none. */
  body: string;
}

/**
 * The pull requests GitHub associates with commit `sha`, with their descriptions
 * (`GET …/commits/{sha}/pulls`, all pages).
 */
export async function readCommitPullRequests(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<CommitPullRequest[]> {
  const pulls = await read(
    `list pull requests of commit ${repo.owner}/${repo.repo}@${sha}`,
    () =>
      client.paginate("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        ...repo,
        commit_sha: sha,
        per_page: 100,
      }),
  );
  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    body: pull.body ?? "",
  }));
}
