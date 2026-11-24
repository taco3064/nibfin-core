import type { GitHubClient } from "./client.ts";
import { readBlockingRecord } from "./issue-query.ts";
import type { IssueRef } from "./repo.ts";

/** An Issue on the other side of a native dependency; it may be in another repository. */
export interface DependencyIssue extends IssueRef {
  state: "open" | "closed";
  labels: string[];
  url: string;
}

/**
 * The Issues `issue` blocks, across repositories, from one GraphQL query, checked
 * against its `issueDependenciesSummary.totalBlocking`: a shorter list (for example
 * Issues the credential cannot see) fails with `GITHUB_READ_FAILED`.
 */
export function readBlocking(
  client: GitHubClient,
  issue: IssueRef,
): Promise<DependencyIssue[]> {
  return readBlockingRecord(client, issue);
}
