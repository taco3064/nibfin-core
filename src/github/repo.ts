/** A repository on GitHub. */
export interface Repo {
  owner: string;
  repo: string;
}

/** An Issue or pull request, addressed by repository and number. */
export interface IssueRef extends Repo {
  number: number;
}

/** `owner/repo#n`, used in operation names. */
export function formatIssue(issue: IssueRef): string {
  return `${issue.owner}/${issue.repo}#${issue.number}`;
}

/**
 * The repository of an API `repository_url` such as
 * `https://api.github.com/repos/<owner>/<repo>`.
 */
export function parseRepositoryUrl(url: string): Repo {
  const parts = new URL(url).pathname.split("/").filter((part) => part !== "");
  if (parts.length < 3 || parts.at(-3) !== "repos") {
    throw new TypeError(`Not a repository API URL: ${url}`);
  }
  const [owner, repo] = parts.slice(-2).map((part) => decodeURIComponent(part));
  return { owner, repo };
}

/** Names of labels as GitHub returns them (objects or plain strings). */
export function labelNames(labels: ReadonlyArray<string | { name?: string }>): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((name): name is string => typeof name === "string");
}
