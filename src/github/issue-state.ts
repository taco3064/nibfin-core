// An Issue's state over REST only (#776): `GET` and `PATCH` of
// `/repos/{owner}/{repo}/issues/{n}`, which a token with only the Issues permission
// (a runner request's job token) may use. Core's other Issue writes read the GraphQL
// Issue record instead (`closeIssueAs`).
import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import { freshReads } from "./read-cache.ts";
import { formatIssue, type IssueRef } from "./repo.ts";
import { write } from "./write.ts";

/** Whether the Issue is `open` or `closed`, read with REST `GET`. */
export async function readIssueState(
  client: GitHubClient,
  issue: IssueRef,
): Promise<string> {
  const { data } = await read(`read the state of ${formatIssue(issue)}`, () =>
    client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
    }),
  );
  return data.state;
}

/**
 * Closes the Issue as not planned with REST `PATCH` through `write()`. Its confirm
 * drops the kept reads (`freshReads`) and reads the state again, so a close that took
 * effect is not sent again; an Issue already closed is left as it is.
 */
export async function closeIssueNotPlanned(
  client: GitHubClient,
  issue: IssueRef,
): Promise<void> {
  const closed = async () => {
    freshReads(client);
    return (await readIssueState(client, issue)) === "closed" ? true : undefined;
  };
  if (await closed()) {
    return;
  }
  await write(
    client,
    `close ${formatIssue(issue)} as not planned`,
    async () => {
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: "not_planned",
      });
      return true;
    },
    { confirm: closed },
  );
}
