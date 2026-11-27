import type { GitHubClient } from "./client.ts";
import { absentProbe, incompleteRead, readOptional } from "./errors.ts";
import { queryGraphql } from "./issue-query.ts";
import { formatIssue, type IssueRef, type Repo } from "./repo.ts";
import { retryIncomplete } from "./retry.ts";

/**
 * The reads the Scope stage supplies to its agents (#735): they hold no GitHub
 * credential, so every GitHub fact they judge comes from here. Each list is read in
 * full through `queryGraphql` (retried like every read); a missing node or an
 * incomplete nested list is an incomplete answer, retried by `retryIncomplete`, and
 * then fails with `GITHUB_READ_FAILED`.
 */

/** A repository's visibility; `internal` counts as private for disclosure. */
export type Visibility = "public" | "private" | "internal";

/** An Issue that an earlier Scope run created from the request (Proposal R3.4). */
export interface OriginIssue {
  /** `owner/repo`. */
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  /** REST's lowercase values, such as `completed`. */
  stateReason: string | null;
  labels: string[];
  assignees: string[];
}

export interface InventoryIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  /** Native Blocked by Issues, from any repository. */
  blockedBy: Array<{ url: string; state: "open" | "closed" }>;
}

export interface ClosedIssue {
  number: number;
  url: string;
  title: string;
  stateReason: string | null;
  labels: string[];
}

export interface OpenPullRequest {
  number: number;
  url: string;
  title: string;
  headRef: string;
}

/** What one repository holds for deduplication, overlaps and disclosure. */
export interface RepositoryInventory {
  /** `owner/repo`. */
  repository: string;
  visibility: Visibility;
  openIssues: InventoryIssue[];
  closedIssues: ClosedIssue[];
  openPullRequests: OpenPullRequest[];
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Connection<T> {
  pageInfo: PageInfo;
  nodes: Array<T | null>;
}

interface Counted<T> {
  totalCount: number;
  nodes: Array<T | null>;
}

/** The nodes of a nested list; a missing node or a count GitHub left out fails. */
function counted<T>(operation: string, what: string, list: Counted<T>): T[] {
  const present = list.nodes.filter((node): node is T => node !== null);
  if (present.length !== list.totalCount) {
    throw incompleteRead(
      operation,
      `Read ${present.length} of ${list.totalCount} ${what}`,
    );
  }
  return present;
}

/** REST's lowercase state reason. */
function reasonOf(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

function stateOf(value: string): "open" | "closed" {
  return value === "CLOSED" ? "closed" : "open";
}

/**
 * Every node of a paged connection: `page(cursor)` reads one page until GitHub reports
 * no next page. A missing connection or node fails.
 */
async function allPages<T>(
  operation: string,
  what: string,
  page: (cursor: string | null) => Promise<Connection<T> | undefined>,
): Promise<T[]> {
  const nodes: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const connection = await page(cursor);
    if (connection === undefined) {
      throw incompleteRead(operation, `GraphQL returned no ${what}`);
    }
    if (connection.nodes.includes(null)) {
      throw incompleteRead(operation, `GraphQL returned a missing ${what} node`);
    }
    nodes.push(...(connection.nodes as T[]));
    if (!connection.pageInfo.hasNextPage) {
      return nodes;
    }
    cursor = connection.pageInfo.endCursor;
  }
}

const labelsField = "labels(first: 100) { totalCount nodes { name } }";
const assigneesField = "assignees(first: 100) { totalCount nodes { login } }";

const originQuery = `query RequestOrigins(
  $owner: String!, $repo: String!, $number: Int!, $cursor: String
) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on Issue {
                number url title body state stateReason
                repository { nameWithOwner }
                ${labelsField}
                ${assigneesField}
              }
            }
          }
        }
      }
    }
  }
}`;

interface SourceIssue {
  __typename: "Issue";
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  repository: { nameWithOwner: string };
  labels: Counted<{ name: string }>;
  assignees: Counted<{ login: string }>;
}

interface TimelineNode {
  __typename: string;
  source?: SourceIssue | { __typename: string } | null;
}

/** True when a line of `body`, trimmed, is exactly `Origin: <request URL>`. */
export function hasOriginLine(body: string, requestUrl: string): boolean {
  const line = `Origin: ${requestUrl}`;
  return body.split(/\r?\n/).some((candidate) => candidate.trim() === line);
}

/** Issues a person discarded: closed as not planned or as a duplicate. */
function discarded(stateReason: string | null): boolean {
  return stateReason === "not_planned" || stateReason === "duplicate";
}

/**
 * The request's own Issues (Proposal R3.4): the Issues (not pull requests) of its
 * cross-reference events whose body has the line `Origin: <request URL>`, without
 * those closed as not planned or as a duplicate, once each by URL.
 */
export async function readOriginIssues(
  client: GitHubClient,
  request: IssueRef & { url: string },
): Promise<OriginIssue[]> {
  const operation = `read the cross-references of ${formatIssue(request)}`;
  return retryIncomplete(client, operation, () =>
    originIssues(client, request, operation),
  );
}

async function originIssues(
  client: GitHubClient,
  request: IssueRef & { url: string },
  operation: string,
): Promise<OriginIssue[]> {
  const events = await allPages<TimelineNode>(
    operation,
    "cross-reference",
    async (cursor) => {
      const data = await queryGraphql<{
        repository: {
          issue: { timelineItems: Connection<TimelineNode> } | null;
        } | null;
      }>(client, operation, originQuery, {
        owner: request.owner,
        repo: request.repo,
        number: request.number,
        cursor,
      });
      return data.repository?.issue?.timelineItems;
    },
  );
  const found = new Map<string, OriginIssue>();
  for (const event of events) {
    const source = event.source;
    if (source?.__typename !== "Issue") {
      continue;
    }
    const issue = source as SourceIssue;
    const reason = reasonOf(issue.stateReason);
    if (!hasOriginLine(issue.body, request.url) || discarded(reason)) {
      continue;
    }
    const what = `of ${issue.url}`;
    found.set(issue.url, {
      repository: issue.repository.nameWithOwner,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      body: issue.body,
      state: stateOf(issue.state),
      stateReason: reason,
      labels: counted(operation, `labels ${what}`, issue.labels).map((n) => n.name),
      assignees: counted(operation, `Assignees ${what}`, issue.assignees).map(
        (n) => n.login,
      ),
    });
  }
  return [...found.values()];
}

const openIssuesQuery = `query RepositoryOpenIssues(
  $owner: String!, $repo: String!, $cursor: String
) {
  repository(owner: $owner, name: $repo) {
    visibility
    issues(states: [OPEN], first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url title body
        ${labelsField}
        ${assigneesField}
        issueDependenciesSummary { totalBlockedBy }
        blockedBy(first: 100) { nodes { url state } }
      }
    }
  }
}`;

const closedIssuesQuery = `query RepositoryClosedIssues(
  $owner: String!, $repo: String!, $cursor: String
) {
  repository(owner: $owner, name: $repo) {
    issues(states: [CLOSED], first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number url title stateReason ${labelsField} }
    }
  }
}`;

const openPullsQuery = `query RepositoryOpenPulls(
  $owner: String!, $repo: String!, $cursor: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: [OPEN], first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number url title headRefName }
    }
  }
}`;

interface OpenIssueNode {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: Counted<{ name: string }>;
  assignees: Counted<{ login: string }>;
  issueDependenciesSummary: { totalBlockedBy: number };
  blockedBy: { nodes: Array<{ url: string; state: string } | null> };
}

interface ClosedIssueNode {
  number: number;
  url: string;
  title: string;
  stateReason: string | null;
  labels: Counted<{ name: string }>;
}

interface PullNode {
  number: number;
  url: string;
  title: string;
  headRefName: string;
}

const visibilities: Record<string, Visibility> = {
  PUBLIC: "public",
  PRIVATE: "private",
  INTERNAL: "internal",
};

type RepositoryPage<Key extends string, T> = {
  repository: ({ visibility?: unknown } & Record<Key, Connection<T>>) | null;
};

/**
 * One repository's visibility (read with its open Issues), its open Issues with text,
 * labels, Assignees and Blocked by, its closed Issues with title, state reason and
 * labels, and its open pull requests with head branch. A missing or unknown
 * visibility fails; it is never guessed.
 */
export async function readRepositoryInventory(
  client: GitHubClient,
  repo: Repo,
): Promise<RepositoryInventory> {
  const name = `${repo.owner}/${repo.repo}`;
  const operation = `read the Issues and pull requests of ${name}`;
  return retryIncomplete(client, operation, () =>
    repositoryInventory(client, repo, name, operation),
  );
}

async function repositoryInventory(
  client: GitHubClient,
  repo: Repo,
  name: string,
  operation: string,
): Promise<RepositoryInventory> {
  let visibility: unknown;
  const pages = <Key extends string, T>(query: string, key: Key) =>
    allPages<T>(operation, key, async (cursor) => {
      const data = await queryGraphql<RepositoryPage<Key, T>>(client, operation, query, {
        owner: repo.owner,
        repo: repo.repo,
        cursor,
      });
      // Only the open-Issue query asks for it; its first page answers.
      visibility ??= data.repository?.visibility;
      return data.repository?.[key];
    });
  const open = await pages<"issues", OpenIssueNode>(openIssuesQuery, "issues");
  const known = typeof visibility === "string" ? visibilities[visibility] : undefined;
  if (known === undefined) {
    throw incompleteRead(operation, `GraphQL returned visibility ${String(visibility)}`);
  }
  const closed = await pages<"issues", ClosedIssueNode>(closedIssuesQuery, "issues");
  const pulls = await pages<"pullRequests", PullNode>(openPullsQuery, "pullRequests");
  return {
    repository: name,
    visibility: known,
    openIssues: open.map((node) => {
      const what = `of ${node.url}`;
      const blockedBy = counted(operation, `Blocked by ${what}`, {
        totalCount: node.issueDependenciesSummary.totalBlockedBy,
        nodes: node.blockedBy.nodes,
      });
      return {
        number: node.number,
        url: node.url,
        title: node.title,
        body: node.body,
        labels: counted(operation, `labels ${what}`, node.labels).map((n) => n.name),
        assignees: counted(operation, `Assignees ${what}`, node.assignees).map(
          (n) => n.login,
        ),
        blockedBy: blockedBy.map((item) => ({
          url: item.url,
          state: stateOf(item.state),
        })),
      };
    }),
    closedIssues: closed.map((node) => ({
      number: node.number,
      url: node.url,
      title: node.title,
      stateReason: reasonOf(node.stateReason),
      labels: counted(operation, `labels of ${node.url}`, node.labels).map((n) => n.name),
    })),
    openPullRequests: pulls.map((node) => ({
      number: node.number,
      url: node.url,
      title: node.title,
      headRef: node.headRefName,
    })),
  };
}

/**
 * Whether `login` can be assigned to Issues of `repo`
 * (`GET /repos/{owner}/{repo}/assignees/{login}`): 204 is yes; 404 is no, an answer
 * that is not retried (Proposal R4.39); any other failure is `GITHUB_READ_FAILED`.
 */
export async function checkAssignable(
  client: GitHubClient,
  repo: Repo,
  login: string,
): Promise<boolean> {
  const answer = await readOptional(
    `check whether ${login} can be assigned in ${repo.owner}/${repo.repo}`,
    () =>
      client.request("GET /repos/{owner}/{repo}/assignees/{assignee}", {
        owner: repo.owner,
        repo: repo.repo,
        assignee: login,
        request: absentProbe,
      }),
  );
  return answer !== undefined;
}
