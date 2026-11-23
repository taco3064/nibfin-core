import type { GitHubClient } from "./client.ts";
import { GitHubError, read } from "./errors.ts";
import { formatIssue, type IssueRef, labelNames, parseRepositoryUrl } from "./repo.ts";

/** An Issue on the other side of a native dependency; it may be in another repository. */
export interface DependencyIssue extends IssueRef {
  state: "open" | "closed";
  labels: string[];
  url: string;
}

export type DependencyKind = "blocked_by" | "blocking";

/**
 * Every Issue of a native dependency list, all pages. When `expectedTotal` (the Issue's
 * `issue_dependencies_summary`) is given, a shorter list means some Issues could not be
 * read, so it fails instead of reporting fewer dependencies.
 */
export async function readDependencies(
  client: GitHubClient,
  issue: IssueRef,
  kind: DependencyKind,
  expectedTotal?: number,
): Promise<DependencyIssue[]> {
  const operation = `read ${kind} of ${formatIssue(issue)}`;
  const route =
    kind === "blocked_by"
      ? "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by"
      : "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking";
  const issues = await read(operation, () =>
    client.paginate(route, {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
      per_page: 100,
    }),
  );
  if (expectedTotal !== undefined && issues.length !== expectedTotal) {
    throw new GitHubError(
      "GITHUB_READ_FAILED",
      operation,
      new Error(`Read ${issues.length} of ${expectedTotal} dependencies`),
    );
  }
  return issues.map((dependency) => ({
    ...parseRepositoryUrl(dependency.repository_url),
    number: dependency.number,
    state: dependency.state === "closed" ? "closed" : "open",
    labels: labelNames(dependency.labels),
    url: dependency.html_url,
  }));
}

/** The Issues `issue` is blocked by. */
export function readBlockedBy(
  client: GitHubClient,
  issue: IssueRef,
  expectedTotal?: number,
): Promise<DependencyIssue[]> {
  return readDependencies(client, issue, "blocked_by", expectedTotal);
}

/** The Issues `issue` blocks, across repositories, checked against its summary. */
export async function readBlocking(
  client: GitHubClient,
  issue: IssueRef,
): Promise<DependencyIssue[]> {
  const { data } = await read(`read ${formatIssue(issue)}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
    }),
  );
  return readDependencies(
    client,
    issue,
    "blocking",
    data.issue_dependencies_summary?.total_blocking,
  );
}
