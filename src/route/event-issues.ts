// The Issues an event names (#776: kept apart from `route.ts`, which reaches the
// stages barrel, so the Action can import it).
import {
  type ActingClient,
  issueOfBranch,
  issuesOfCommit,
  type Repo,
} from "../github/index.ts";

/** What an event names: an Issue, or a commit or branch to map to one. */
export type RouteTarget = { issue: number } | { sha: string } | { branch: string };

/**
 * The Issues of an event target, without repeats: the Issue itself; the Issue of a
 * `nibfin/issue-<n>[-cd-<k>]` branch; or for a commit, the Issues of every open or
 * merged pull request of `GET /commits/{sha}/pulls` whose head is such a branch,
 * then those of every merged pull request whose `merge_commit_sha` is the commit
 * (a pull request that merged without moving the base is not associated with it,
 * #771). Empty when the target belongs to no Issue.
 */
export async function routeEvent(
  client: ActingClient,
  repo: Repo,
  target: RouteTarget,
): Promise<number[]> {
  if ("issue" in target) {
    return [target.issue];
  }
  if ("branch" in target) {
    const issue = issueOfBranch(target.branch);
    return issue === undefined ? [] : [issue];
  }
  return issuesOfCommit(client, repo, target.sha);
}
