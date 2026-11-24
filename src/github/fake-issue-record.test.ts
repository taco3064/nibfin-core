// Test support: answers Nibfin's Issue-record GraphQL queries from the fake GitHub's
// REST route table, so REST fixtures describe both APIs. It holds no tests of its own.
import { labelNames, parseRepositoryUrl } from "./repo.ts";

export interface RestAnswer {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

/** Calls a REST route of the fake: `GET <path>` with a query string. */
export type RestGet = (
  path: string,
  query?: Record<string, string>,
) => Promise<RestAnswer>;

/** The REST route paths the fake defines, to find fix-branch refs. */
export type RestPaths = () => string[];

/** A REST answer that is a failure for GraphQL too; 404 is left to the caller. */
class Failed extends Error {
  readonly answer: RestAnswer;
  constructor(answer: RestAnswer) {
    super("REST route failed");
    this.answer = answer;
  }
}

async function ok(answer: Promise<RestAnswer>, absent: unknown): Promise<unknown> {
  const { status, data } = await answer;
  if (status === 404) {
    return absent;
  }
  if (status >= 400) {
    throw new Failed(await answer);
  }
  return data;
}

interface RestIssue {
  number: number;
  state: string;
  state_reason?: string | null;
  title?: string;
  body?: string | null;
  html_url: string;
  repository_url: string;
  labels: Array<string | { name?: string }>;
  assignees?: Array<{ id: number; login: string }> | null;
  pull_request?: unknown;
  issue_dependencies_summary?: { total_blocked_by: number; total_blocking: number };
}

interface RestComment {
  id: number;
  user: { id: number } | null;
  body: string | null;
  html_url: string;
  /** Fake-only: `userContentEdits.totalCount` (0 for a comment never edited). */
  edits?: number;
}

interface RestPull {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string };
  merge_commit_sha: string | null;
  html_url: string;
}

function labelsOf(labels: RestIssue["labels"]) {
  const nodes = labelNames(labels).map((name) => ({ name }));
  return { totalCount: nodes.length, nodes };
}

function dependencyNode(issue: RestIssue) {
  const { owner, repo } = parseRepositoryUrl(issue.repository_url);
  return {
    number: issue.number,
    state: issue.state.toUpperCase(),
    url: issue.html_url,
    repository: { name: repo, owner: { login: owner } },
    labels: labelsOf(issue.labels),
  };
}

function commentNode(comment: RestComment) {
  return {
    databaseId: comment.id,
    body: comment.body ?? "",
    url: comment.html_url,
    author: comment.user === null ? null : { databaseId: comment.user.id },
    userContentEdits: { totalCount: comment.edits ?? 0 },
  };
}

function pullNode(pull: RestPull, fullName: string) {
  const head = pull.head.repo?.full_name;
  return {
    number: pull.number,
    state: pull.merged_at !== null ? "MERGED" : pull.state.toUpperCase(),
    merged: pull.merged_at !== null,
    headRefName: pull.head.ref,
    headRefOid: pull.head.sha,
    baseRefName: pull.base.ref,
    url: pull.html_url,
    isCrossRepository: head !== undefined && head.toLowerCase() !== fullName,
    mergeCommit:
      pull.merged_at !== null && pull.merge_commit_sha !== null
        ? { oid: pull.merge_commit_sha }
        : null,
  };
}

interface Variables {
  owner: string;
  repo: string;
  number?: number;
  cursor?: string;
  branch?: string;
  fixQuery?: string;
  [fix: string]: unknown;
}

class Composer {
  readonly get: RestGet;
  readonly paths: RestPaths;
  readonly vars: Variables;

  constructor(get: RestGet, paths: RestPaths, vars: Variables) {
    this.get = get;
    this.paths = paths;
    this.vars = vars;
  }

  get base() {
    return `/repos/${this.vars.owner}/${this.vars.repo}`;
  }

  get issuePath() {
    return `${this.base}/issues/${this.vars.number}`;
  }

  async list<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    return (await ok(this.get(path, { per_page: "100", ...query }), [])) as T[];
  }

  /** One page of comments; the cursor is the REST page number. */
  async comments(page: string) {
    const answer = await this.get(`${this.issuePath}/comments`, {
      per_page: "100",
      page,
    });
    const items = (await ok(Promise.resolve(answer), [])) as RestComment[];
    const next = /rel="next"/.test(answer.headers?.link ?? "");
    return {
      pageInfo: { hasNextPage: next, endCursor: next ? String(Number(page) + 1) : null },
      nodes: items.map(commentNode),
    };
  }

  async pulls(branch: string) {
    const pulls = await this.list<RestPull>(`${this.base}/pulls`, {
      head: `${this.vars.owner}:${branch}`,
      state: "all",
    });
    const fullName = `${this.vars.owner}/${this.vars.repo}`.toLowerCase();
    return {
      pageInfo: { hasNextPage: false },
      nodes: pulls
        .filter((pull) => pull.head.ref === branch)
        .map((pull) => pullNode(pull, fullName)),
    };
  }

  async fixPulls() {
    const fixes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(this.vars)) {
      if (/^fix\d+$/.test(name)) {
        fixes[name] = await this.pulls(value as string);
      }
    }
    return fixes;
  }

  async ref(branch: string) {
    const found = await ok(this.get(`${this.base}/git/ref/heads/${branch}`), null);
    return found === null ? null : { name: branch };
  }

  async fixRefs() {
    const prefix = `GET ${this.base}/git/ref/heads/nibfin/${this.vars.fixQuery}`;
    const nodes = [];
    for (const path of this.paths().filter((key) => key.startsWith(prefix))) {
      const branch = path.slice(`GET ${this.base}/git/ref/heads/`.length);
      if ((await this.ref(branch)) !== null) {
        nodes.push({ name: branch.slice("nibfin/".length) });
      }
    }
    return { pageInfo: { hasNextPage: false }, nodes };
  }

  async issue() {
    const issue = (await ok(this.get(this.issuePath), null)) as RestIssue | null;
    if (issue === null) {
      return null;
    }
    const blockedBy = await this.list<RestIssue>(
      `${this.issuePath}/dependencies/blocked_by`,
    );
    return {
      __typename: issue.pull_request ? "PullRequest" : "Issue",
      state: issue.state.toUpperCase(),
      stateReason: issue.state_reason ? issue.state_reason.toUpperCase() : null,
      url: issue.html_url,
      title: issue.title ?? "",
      body: issue.body ?? "",
      labels: labelsOf(issue.labels),
      assignees: {
        totalCount: (issue.assignees ?? []).length,
        nodes: (issue.assignees ?? []).map((user) => ({
          databaseId: user.id,
          login: user.login,
        })),
      },
      issueDependenciesSummary: {
        totalBlockedBy:
          issue.issue_dependencies_summary?.total_blocked_by ?? blockedBy.length,
      },
      blockedBy: { nodes: blockedBy.map(dependencyNode) },
      comments: await this.comments("1"),
    };
  }

  async record() {
    const issue = await this.issue();
    const branch = this.vars.branch!;
    const repository = {
      issueOrPullRequest: issue,
      delivery: await this.pulls(branch),
      ref: await this.ref(branch),
      fixRefs: await this.fixRefs(),
      ...(await this.fixPulls()),
    };
    if (issue === null) {
      const message = `Could not resolve to an issue numbered ${this.vars.number}.`;
      return { data: { repository }, errors: [{ type: "NOT_FOUND", message }] };
    }
    return { data: { repository } };
  }

  async blocking() {
    const issue = (await ok(this.get(this.issuePath), null)) as RestIssue | null;
    if (issue === null) {
      return { data: { repository: { issue: null } } };
    }
    const blocking = await this.list<RestIssue>(
      `${this.issuePath}/dependencies/blocking`,
    );
    const total = issue.issue_dependencies_summary?.total_blocking ?? blocking.length;
    return {
      data: {
        repository: {
          issue: {
            issueDependenciesSummary: { totalBlocking: total },
            blocking: { nodes: blocking.map(dependencyNode) },
          },
        },
      },
    };
  }
}

/** The operations answered here, by GraphQL operation name. */
export const recordOperations = [
  "IssueRecord",
  "IssueFixBranches",
  "IssueComments",
  "IssueBlocking",
];

/** The operation name of a GraphQL query body, such as `IssueRecord`. */
export function operationOf(body: unknown): string | undefined {
  const query = (body as { query?: unknown } | undefined)?.query;
  return typeof query === "string" ? /^\s*query\s+(\w+)/.exec(query)?.[1] : undefined;
}

/**
 * The answer to an Issue-record operation, composed from REST routes: the Issue,
 * its Blocked by and blocking lists, comments (with the fake-only `edits` count), pull
 * requests by head branch and branch refs. A failing REST route fails the query with
 * the same status.
 */
export async function answerRecordQuery(
  body: unknown,
  get: RestGet,
  paths: RestPaths,
): Promise<RestAnswer> {
  const { variables } = body as { variables: Variables };
  const composer = new Composer(get, paths, variables);
  try {
    switch (operationOf(body)) {
      case "IssueRecord":
        return { status: 200, data: await composer.record() };
      case "IssueFixBranches":
        return { status: 200, data: { data: { repository: await composer.fixPulls() } } };
      case "IssueComments":
        return {
          status: 200,
          data: {
            data: {
              repository: {
                issue: { comments: await composer.comments(variables.cursor!) },
              },
            },
          },
        };
      default:
        return { status: 200, data: await composer.blocking() };
    }
  } catch (error) {
    if (error instanceof Failed) {
      return error.answer;
    }
    throw error;
  }
}
