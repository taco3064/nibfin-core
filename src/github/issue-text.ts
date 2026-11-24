import type { GitHubClient } from "./client.ts";
import { readIssueRecord } from "./issue-query.ts";
import type { IssueRef } from "./repo.ts";

/** The text of an Issue, which the snapshot leaves out. */
export interface IssueText {
  title: string;
  /** An Issue without a description has the empty body. */
  body: string;
}

/**
 * Reads an Issue's current title and body from its Issue record; any failure is
 * `GITHUB_READ_FAILED`.
 */
export async function readIssueText(
  client: GitHubClient,
  issue: IssueRef,
): Promise<IssueText> {
  const { title, body } = await readIssueRecord(client, issue);
  return { title, body };
}
