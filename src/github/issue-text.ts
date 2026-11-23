import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import { formatIssue, type IssueRef } from "./repo.ts";

/** The text of an Issue, which the snapshot leaves out. */
export interface IssueText {
  title: string;
  /** An Issue without a description has the empty body. */
  body: string;
}

/** Reads an Issue's current title and body; any failure is `GITHUB_READ_FAILED`. */
export async function readIssueText(
  client: GitHubClient,
  issue: IssueRef,
): Promise<IssueText> {
  const { data } = await read(`read text of ${formatIssue(issue)}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
    }),
  );
  return { title: data.title, body: data.body ?? "" };
}
