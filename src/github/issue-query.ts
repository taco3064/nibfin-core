import {
  type BranchProbe,
  cdFixBranch,
  deliveryBranch,
  type IssueBranches,
  type PullRequestSummary,
} from "./branches.ts";
import type { Actor, GitHubClient } from "./client.ts";
import type { DependencyIssue } from "./dependencies.ts";
import { GitHubError, read } from "./errors.ts";
import { formatIssue, type IssueRef } from "./repo.ts";

/**
 * One GraphQL query; GraphQL `errors` or a missing `data` fail it with
 * `GITHUB_READ_FAILED`, so no partial answer is used.
 */
export async function queryGraphql<T>(
  client: GitHubClient,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const answer = await read(operation, () =>
    client.request("POST /graphql", { query, variables }),
  );
  const { data, errors } = answer.data as { data?: T | null; errors?: unknown[] };
  if (errors !== undefined || data === undefined || data === null) {
    const first = (errors?.[0] as { message?: unknown } | undefined)?.message;
    const reason = typeof first === "string" ? first : "GraphQL returned no data";
    throw new GitHubError("GITHUB_READ_FAILED", operation, new Error(reason));
  }
  return data;
}

/** An Issue comment as the record reads it. */
export interface RecordComment {
  id: number;
  /** The author's user id; `null` for a deleted account or an organization. */
  authorId: number | null;
  body: string;
  url: string;
  /** Body versions: 1 until an edit, then every edit plus the original. */
  versions: number;
}

/** Everything one Issue-record query reads about an Issue (see `readIssueRecord`). */
export interface IssueRecord {
  issue: IssueRef;
  state: "open" | "closed";
  /** REST's values: `completed`, `not_planned`, `reopened`, `duplicate`. */
  stateReason: string | null;
  url: string;
  title: string;
  /** An Issue without a description has the empty body. */
  body: string;
  labels: string[];
  /** In GitHub's order. */
  assignees: Actor[];
  /** Native Blocked by Issues, from any repository. */
  blockedBy: DependencyIssue[];
  /** All comments, oldest first. */
  comments: RecordComment[];
  branches: IssueBranches;
}

/** How many fix branches one query probes for pull requests. */
const fixBatch = 3;

const pullsFragment = `fragment Pulls on PullRequestConnection {
  pageInfo { hasNextPage }
  nodes {
    number state merged headRefName headRefOid baseRefName url isCrossRepository
    mergeCommit { oid }
  }
}`;

const commentsFragment = `fragment Comments on IssueCommentConnection {
  pageInfo { hasNextPage endCursor }
  nodes {
    fullDatabaseId body url
    author { ... on User { databaseId } ... on Bot { databaseId } }
    userContentEdits(first: 1) { totalCount }
  }
}`;

const dependencyFragment = `fragment Dependency on Issue {
  number state url
  repository { name owner { login } }
  labels(first: 100) { totalCount nodes { name } }
}`;

const fixVariables = Array.from({ length: fixBatch }, (_, i) => `$fix${i + 1}: String!`);
const fixFields = Array.from(
  { length: fixBatch },
  (_, i) =>
    `fix${i + 1}: pullRequests(headRefName: $fix${i + 1}, first: 100) { ...Pulls }`,
);

const recordQuery = `query IssueRecord(
  $owner: String!, $repo: String!, $number: Int!
  $branch: String!, $ref: String!, $fixQuery: String!, ${fixVariables.join(", ")}
) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        state stateReason url title body
        labels(first: 100) { totalCount nodes { name } }
        assignees(first: 100) { totalCount nodes { databaseId login } }
        issueDependenciesSummary { totalBlockedBy }
        blockedBy(first: 100) { nodes { ...Dependency } }
        comments(first: 100) { ...Comments }
      }
    }
    delivery: pullRequests(headRefName: $branch, first: 100) { ...Pulls }
    ref(qualifiedName: $ref) { name }
    fixRefs: refs(refPrefix: "refs/heads/nibfin/", query: $fixQuery, first: 100) {
      pageInfo { hasNextPage }
      nodes { name }
    }
    ${fixFields.join("\n    ")}
  }
}
${pullsFragment}
${commentsFragment}
${dependencyFragment}`;

const fixQuery = `query IssueFixBranches(
  $owner: String!, $repo: String!, ${fixVariables.join(", ")}
) {
  repository(owner: $owner, name: $repo) {
    ${fixFields.join("\n    ")}
  }
}
${pullsFragment}`;

const commentsQuery = `query IssueComments(
  $owner: String!, $repo: String!, $number: Int!, $cursor: String!
) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { comments(first: 100, after: $cursor) { ...Comments } }
  }
}
${commentsFragment}`;

const blockingQuery = `query IssueBlocking(
  $owner: String!, $repo: String!, $number: Int!
) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      issueDependenciesSummary { totalBlocking }
      blocking(first: 100) { nodes { ...Dependency } }
    }
  }
}
${dependencyFragment}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface Named {
  totalCount: number;
  nodes: Array<{ name: string } | null>;
}

interface PullNode {
  number: number;
  state: string;
  merged: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  url: string;
  isCrossRepository: boolean;
  mergeCommit: { oid: string } | null;
}

interface Pulls {
  pageInfo: PageInfo;
  nodes: Array<PullNode | null>;
}

interface CommentNode {
  /** A GraphQL `BigInt` (a string): comment ids exceed the 32-bit `databaseId`. */
  fullDatabaseId: string | null;
  body: string;
  url: string;
  author: { databaseId?: number } | null;
  userContentEdits: { totalCount: number } | null;
}

interface Comments {
  pageInfo: PageInfo;
  nodes: Array<CommentNode | null>;
}

interface DependencyNode {
  number: number;
  state: string;
  url: string;
  repository: { name: string; owner: { login: string } };
  labels: Named;
}

interface IssueNode {
  __typename: string;
  state: string;
  stateReason: string | null;
  url: string;
  title: string;
  body: string;
  labels: Named;
  assignees: {
    totalCount: number;
    nodes: Array<{ databaseId: number; login: string } | null>;
  };
  issueDependenciesSummary: { totalBlockedBy: number };
  blockedBy: { nodes: Array<DependencyNode | null> };
  comments: Comments;
}

type FixPulls = Record<string, Pulls | undefined>;

interface RecordData {
  repository: {
    issueOrPullRequest: IssueNode | null;
    delivery: Pulls;
    ref: { name: string } | null;
    fixRefs: { pageInfo: PageInfo; nodes: Array<{ name: string } | null> };
  } & FixPulls;
}

function incomplete(operation: string, what: string): GitHubError {
  return new GitHubError("GITHUB_READ_FAILED", operation, new Error(what));
}

/** The nodes of a connection; a missing node or a count GitHub left out fails. */
function allNodes<T>(
  operation: string,
  what: string,
  nodes: Array<T | null>,
  total: number,
): T[] {
  const present = nodes.filter((node): node is T => node !== null);
  if (present.length !== total) {
    throw incomplete(operation, `Read ${present.length} of ${total} ${what}`);
  }
  return present;
}

function names(operation: string, what: string, labels: Named): string[] {
  return allNodes(operation, what, labels.nodes, labels.totalCount).map((n) => n.name);
}

function dependency(operation: string, node: DependencyNode): DependencyIssue {
  return {
    owner: node.repository.owner.login,
    repo: node.repository.name,
    number: node.number,
    state: node.state === "CLOSED" ? "closed" : "open",
    labels: names(operation, `labels of #${node.number}`, node.labels),
    url: node.url,
  };
}

/** The dependency list checked against the Issue's summary count. */
function dependencies(
  operation: string,
  nodes: Array<DependencyNode | null>,
  total: number,
): DependencyIssue[] {
  const present = allNodes(operation, "dependencies", nodes, total);
  return present.map((node) => dependency(operation, node));
}

/**
 * The pull requests of one head branch whose head is in this repository (like REST's
 * `head: owner:branch`), newest first.
 */
function pullRequests(operation: string, branch: string, pulls: Pulls) {
  if (pulls.pageInfo.hasNextPage) {
    throw incomplete(operation, `More than 100 pull requests of ${branch}`);
  }
  return pulls.nodes
    .filter((pull): pull is PullNode => pull !== null && !pull.isCrossRepository)
    .filter((pull) => pull.headRefName === branch)
    .map((pull): PullRequestSummary => ({
      number: pull.number,
      state: pull.state === "OPEN" ? "open" : "closed",
      merged: pull.merged,
      headRef: pull.headRefName,
      headSha: pull.headRefOid,
      baseRef: pull.baseRefName,
      mergeCommitSha: pull.mergeCommit?.oid ?? null,
      url: pull.url,
    }))
    .toSorted((a, b) => b.number - a.number);
}

function comment(operation: string, node: CommentNode): RecordComment {
  const id = Number(node.fullDatabaseId);
  if (node.fullDatabaseId === null || !Number.isSafeInteger(id) || id <= 0) {
    throw incomplete(operation, `GraphQL returned comment id ${node.fullDatabaseId}`);
  }
  return {
    id,
    authorId: node.author?.databaseId ?? null,
    body: node.body,
    url: node.url,
    versions: Math.max(1, node.userContentEdits?.totalCount ?? 0),
  };
}

/** Every comment: the first page from the record, follow-up pages past 100. */
async function allComments(
  client: GitHubClient,
  issue: IssueRef,
  operation: string,
  first: Comments,
): Promise<RecordComment[]> {
  const nodes = [...first.nodes];
  let page = first.pageInfo;
  while (page.hasNextPage) {
    const data = await queryGraphql<{
      repository: { issue: { comments: Comments } | null } | null;
    }>(client, operation, commentsQuery, {
      ...variablesOf(issue),
      cursor: page.endCursor,
    });
    const comments = data.repository?.issue?.comments;
    if (comments === undefined) {
      throw incomplete(operation, "GraphQL returned no comments");
    }
    nodes.push(...comments.nodes);
    page = comments.pageInfo;
  }
  if (nodes.includes(null)) {
    throw incomplete(operation, "GraphQL returned a missing comment");
  }
  return (nodes as CommentNode[]).map((node) => comment(operation, node));
}

function variablesOf(issue: IssueRef) {
  return { owner: issue.owner, repo: issue.repo, number: issue.number };
}

function fixNames(issue: IssueRef, from: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: fixBatch }, (_, i) => [
      `fix${i + 1}`,
      cdFixBranch(issue.number, from + i),
    ]),
  );
}

/**
 * The delivery branch and every fix branch `-cd-1`, `-cd-2`, … up to the first `k` that
 * has neither a pull request nor a ref; batches after the first are queried in turn.
 */
async function issueBranches(
  client: GitHubClient,
  issue: IssueRef,
  operation: string,
  repository: RecordData["repository"],
): Promise<IssueBranches> {
  const delivery: BranchProbe = {
    name: deliveryBranch(issue.number),
    exists: repository.ref !== null,
    pullRequests: pullRequests(
      operation,
      deliveryBranch(issue.number),
      repository.delivery,
    ),
  };
  if (repository.fixRefs.pageInfo.hasNextPage) {
    throw incomplete(operation, "More than 100 fix branches");
  }
  // Names under `refs/heads/nibfin/`; the query may match more, only exact names count.
  const refs = new Set(
    repository.fixRefs.nodes.flatMap((node) =>
      node === null ? [] : [`nibfin/${node.name}`],
    ),
  );
  const fixes: BranchProbe[] = [];
  let batch: FixPulls = repository;
  for (;;) {
    const from = fixes.length + 1;
    const branches = fixNames(issue, from);
    for (const [alias, name] of Object.entries(branches)) {
      const pulls = batch[alias];
      if (pulls === undefined) {
        throw incomplete(operation, `GraphQL returned no pull requests of ${name}`);
      }
      const probe = {
        name,
        exists: refs.has(name),
        pullRequests: pullRequests(operation, name, pulls),
      };
      if (!probe.exists && probe.pullRequests.length === 0) {
        return {
          delivery,
          fixes,
          current: fixes.at(-1) ?? delivery,
          nextFixBranch: name,
        };
      }
      fixes.push(probe);
    }
    const next = fixNames(issue, fixes.length + 1);
    const data = await queryGraphql<{ repository: FixPulls | null }>(
      client,
      operation,
      fixQuery,
      { owner: issue.owner, repo: issue.repo, ...next },
    );
    batch = data.repository ?? {};
  }
}

/**
 * Reads an Issue with one GraphQL query (follow-up queries only past 100 comments or
 * past the first fix branches): state, state reason, text, labels, Assignees, Blocked
 * by (checked against `issueDependenciesSummary.totalBlockedBy`), all comments, and
 * the pull requests and refs of its delivery and CD fix branches. A pull request
 * number, a missing Issue or an incomplete list fails with `GITHUB_READ_FAILED`.
 * Repeated calls in a Job send the same request, so the read cache answers them.
 */
export async function readIssueRecord(
  client: GitHubClient,
  issue: IssueRef,
): Promise<IssueRecord> {
  const ref: IssueRef = { owner: issue.owner, repo: issue.repo, number: issue.number };
  const operation = `read ${formatIssue(ref)}`;
  const branch = deliveryBranch(ref.number);
  const data = await queryGraphql<RecordData>(client, operation, recordQuery, {
    ...variablesOf(ref),
    branch,
    ref: `refs/heads/${branch}`,
    fixQuery: `issue-${ref.number}-cd-`,
    ...fixNames(ref, 1),
  });
  const node = data.repository?.issueOrPullRequest;
  if (node === null || node === undefined || node.__typename !== "Issue") {
    const what =
      node?.__typename === "PullRequest" ? "is a pull request" : "was not found";
    throw incomplete(operation, `${formatIssue(ref)} ${what}`);
  }
  const assignees = node.assignees;
  return {
    issue: ref,
    state: node.state === "CLOSED" ? "closed" : "open",
    stateReason: node.stateReason === null ? null : node.stateReason.toLowerCase(),
    url: node.url,
    title: node.title,
    body: node.body,
    labels: names(operation, "labels", node.labels),
    assignees: allNodes(
      operation,
      "Assignees",
      assignees.nodes,
      assignees.totalCount,
    ).map((user) => ({ id: user.databaseId, login: user.login })),
    blockedBy: dependencies(
      operation,
      node.blockedBy.nodes,
      node.issueDependenciesSummary.totalBlockedBy,
    ),
    comments: await allComments(client, ref, operation, node.comments),
    branches: await issueBranches(client, ref, operation, data.repository),
  };
}

/** The Issues `issue` blocks, across repositories, checked against its summary. */
export async function readBlockingRecord(
  client: GitHubClient,
  issue: IssueRef,
): Promise<DependencyIssue[]> {
  const operation = `read blocking of ${formatIssue(issue)}`;
  const data = await queryGraphql<{
    repository: {
      issue: {
        issueDependenciesSummary: { totalBlocking: number };
        blocking: { nodes: Array<DependencyNode | null> };
      } | null;
    } | null;
  }>(client, operation, blockingQuery, variablesOf(issue));
  const node = data.repository?.issue;
  if (node === null || node === undefined) {
    throw incomplete(operation, `${formatIssue(issue)} was not found`);
  }
  return dependencies(
    operation,
    node.blocking.nodes,
    node.issueDependenciesSummary.totalBlocking,
  );
}
