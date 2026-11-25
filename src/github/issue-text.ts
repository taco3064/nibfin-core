import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
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

/** An Issue's title and URL. */
export interface IssueTitle {
  title: string;
  url: string;
}

/**
 * An Issue's current title and URL (`GET …/issues/{n}`); any failure is
 * `GITHUB_READ_FAILED`.
 */
export async function readIssueTitle(
  client: GitHubClient,
  issue: IssueRef,
): Promise<IssueTitle> {
  const { owner, repo, number } = issue;
  const { data } = await read(`read Issue ${owner}/${repo}#${number}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: number,
    }),
  );
  return { title: data.title, url: data.html_url };
}
