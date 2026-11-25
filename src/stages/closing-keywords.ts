import type { IssueRef, Repo } from "../github/index.ts";

/** GitHub's closing keywords, as a regular expression alternation. */
export const closingKeywords =
  "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regular expression source for a reference to Issue `number` (itself a regular
 * expression source) of `repo`: `#n`, `owner/repo#n` or the Issue's URL.
 */
export function issueTarget(repo: Repo, number: string): string {
  const path = `${escape(repo.owner)}/${escape(repo.repo)}`;
  return `(?:(?:${path})?#${number}|https://github\\.com/${path}/issues/${number})`;
}

/**
 * A GitHub closing keyword that refers to `issue`: `#n`, `owner/repo#n` or the Issue's
 * URL after one of the keywords, with an optional colon. Such a commit message would
 * close the Issue when merged into the default branch, before CD has run.
 */
function closingPattern(issue: IssueRef): RegExp {
  const target = issueTarget(issue, String(issue.number));
  return new RegExp(`\\b(?:${closingKeywords}):?\\s+${target}(?![\\w/-])`, "i");
}

/** The messages that would close `issue` when merged. */
export function closingMessages(messages: readonly string[], issue: IssueRef): string[] {
  const pattern = closingPattern(issue);
  return messages.filter((message) => pattern.test(message));
}
