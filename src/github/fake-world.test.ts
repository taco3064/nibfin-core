// Test support: a stateful fake of several repositories' Issues behind the fake GitHub
// API, for the Scope stage's publication (#736): Issues with REST ids, creation,
// native Blocked by edges in both directions, Assignees, labels, comments, the
// repository Issue listing, assignability and the request reads (cross-references and
// inventories). It holds no tests of its own.
import {
  type FakeGitHub,
  type FakeRequest,
  type FakeResponse,
  fakeActor,
  fakeGitHub,
  paged,
} from "./fake-github.test.ts";
import { operationOf } from "./fake-issue-record.test.ts";

export interface WorldComment {
  id: number;
  userId: number;
  body: string;
}

export interface WorldIssue {
  owner: string;
  repo: string;
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  /** Keys (`owner/repo#n`) of the Issues this one is Blocked by. */
  blockedBy: string[];
  comments: WorldComment[];
  creatorId: number;
  /** Whether its cross-reference on a request appears (false: GitHub lags). */
  crossReferenced: boolean;
  pullRequest?: boolean;
}

/**
 * Lets a test change how a request is answered: `apply` performs it as usual. The
 * default answers with `apply()`.
 */
type Answer = FakeResponse | Promise<FakeResponse>;
export type WorldHook = (request: FakeRequest, apply: () => Answer) => Answer;

export interface FakeWorld {
  github: FakeGitHub;
  issues: Map<string, WorldIssue>;
  /** `owner/repo` → its visibility for GraphQL (`PUBLIC`, …). */
  visibility: Map<string, string>;
  /** `owner/repo:login` entries that cannot be assigned. */
  unassignable: Set<string>;
  /** Logins GitHub silently ignores when they are assigned. */
  ignoredAssignees: Set<string>;
  hook: WorldHook;
  /** Adds an Issue (and its routes); the rest of its fields default. */
  add(fields: Partial<WorldIssue> & { repo: string; number: number }): WorldIssue;
  get(key: string): WorldIssue;
  url(issue: WorldIssue): string;
  /** Keys of the Issues `issue` blocks. */
  blocking(issue: WorldIssue): string[];
}

export const keyOf = (issue: { owner: string; repo: string; number: number }) =>
  `${issue.owner}/${issue.repo}#${issue.number}`;

let nextId = 900_000;
let nextComment = 70_000;

const list = <T>(nodes: T[]) => ({ totalCount: nodes.length, nodes });
const page = <T>(nodes: T[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

export function fakeWorld(): FakeWorld {
  const github = fakeGitHub();
  const issues = new Map<string, WorldIssue>();
  const repositories = new Set<string>();
  const world: FakeWorld = {
    github,
    issues,
    visibility: new Map(),
    unassignable: new Set(),
    ignoredAssignees: new Set(),
    hook: (_request, apply) => apply(),
    add,
    get: (key) => {
      const issue = issues.get(key);
      if (issue === undefined) {
        throw new Error(`No Issue ${key}`);
      }
      return issue;
    },
    url: (issue) =>
      `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`,
    blocking: (issue) =>
      [...issues.values()]
        .filter((other) => other.blockedBy.includes(keyOf(issue)))
        .map(keyOf),
  };
  const route = (key: string, apply: (request: FakeRequest) => Answer) => {
    github.routes.set(key, (request) => world.hook(request, () => apply(request)));
  };
  const json = (issue: WorldIssue) => ({
    id: issue.id,
    number: issue.number,
    state: issue.state,
    state_reason: issue.stateReason,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login, i) => ({ id: 100 + i, login })),
    user: { id: issue.creatorId, login: `user-${issue.creatorId}` },
    repository_url: `https://api.github.com/repos/${issue.owner}/${issue.repo}`,
    html_url: world.url(issue),
    ...(issue.pullRequest ? { pull_request: { url: "x" } } : {}),
  });
  const commentJson = (issue: WorldIssue, comment: WorldComment) => ({
    id: comment.id,
    user: { id: comment.userId, login: `user-${comment.userId}` },
    body: comment.body,
    html_url: `${world.url(issue)}#issuecomment-${comment.id}`,
  });
  function routeRepository(owner: string, repo: string) {
    const name = `${owner}/${repo}`;
    if (repositories.has(name)) {
      return;
    }
    repositories.add(name);
    route(`GET /repos/${name}/issues`, (request) => {
      const creator = request.query.get("creator");
      const found = [...issues.values()]
        .filter((issue) => `${issue.owner}/${issue.repo}` === name)
        .filter((issue) => creator === null || creatorLogin(issue) === creator)
        .toSorted((a, b) => b.number - a.number)
        .map(json);
      return { data: found.slice(0, Number(request.query.get("per_page") ?? "30")) };
    });
    route(`POST /repos/${name}/issues`, (request) => {
      const { title, body } = request.body as { title: string; body: string };
      const numbers = [...issues.values()]
        .filter((issue) => `${issue.owner}/${issue.repo}` === name)
        .map((issue) => issue.number);
      const issue = add({
        owner,
        repo,
        number: Math.max(0, ...numbers) + 1,
        title,
        body,
        creatorId: fakeActor.id,
      });
      return { status: 201, data: json(issue) };
    });
    for (const login of ["taco", "mika"]) {
      github.routes.set(`GET /repos/${name}/assignees/${login}`, () =>
        world.unassignable.has(`${name}:${login}`)
          ? { status: 404, data: { message: "Not Found" } }
          : { status: 204 },
      );
    }
  }
  const creatorLogin = (issue: WorldIssue) =>
    issue.creatorId === fakeActor.id ? fakeActor.login : `user-${issue.creatorId}`;
  function add(fields: Partial<WorldIssue> & { repo: string; number: number }) {
    const issue: WorldIssue = {
      owner: "acme",
      id: nextId++,
      title: `Issue ${fields.number}`,
      body: "",
      state: "open",
      stateReason: null,
      labels: [],
      assignees: [],
      blockedBy: [],
      comments: [],
      creatorId: 7,
      crossReferenced: true,
      ...fields,
    };
    issues.set(keyOf(issue), issue);
    routeRepository(issue.owner, issue.repo);
    const base = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
    route(`GET ${base}`, () => ({ data: json(issue) }));
    route(`GET ${base}/dependencies/blocked_by`, (request) =>
      paged(issue.blockedBy.map((key) => json(world.get(key))))(request),
    );
    route(`GET ${base}/dependencies/blocking`, (request) =>
      paged(world.blocking(issue).map((key) => json(world.get(key))))(request),
    );
    route(`POST ${base}/dependencies/blocked_by`, (request) => {
      const { issue_id } = request.body as { issue_id: number };
      const blocker = [...issues.values()].find((other) => other.id === issue_id);
      if (blocker === undefined) {
        return { status: 404, data: { message: "Not Found" } };
      }
      if (issue.blockedBy.includes(keyOf(blocker))) {
        return { status: 422, data: { message: "Dependency already exists" } };
      }
      issue.blockedBy.push(keyOf(blocker));
      return { status: 201, data: json(blocker) };
    });
    route(`POST ${base}/assignees`, (request) => {
      const { assignees } = request.body as { assignees: string[] };
      for (const login of assignees) {
        if (!world.ignoredAssignees.has(login) && !issue.assignees.includes(login)) {
          issue.assignees.push(login);
        }
      }
      return { status: 201, data: json(issue) };
    });
    route(`POST ${base}/labels`, (request) => {
      const { labels } = request.body as { labels: string[] };
      issue.labels.push(...labels.filter((label) => !issue.labels.includes(label)));
      return { data: issue.labels.map((name) => ({ name })) };
    });
    route(`PATCH ${base}`, (request) => {
      const { state, state_reason } = request.body as {
        state: "closed";
        state_reason: string;
      };
      issue.state = state;
      issue.stateReason = state_reason;
      return { data: json(issue) };
    });
    route(`GET ${base}/comments`, (request) =>
      paged(issue.comments.map((comment) => commentJson(issue, comment)))(request),
    );
    route(`POST ${base}/comments`, (request) => {
      const { body } = request.body as { body: string };
      const comment = { id: nextComment++, userId: fakeActor.id, body };
      issue.comments.push(comment);
      route(
        `PATCH /repos/${issue.owner}/${issue.repo}/issues/comments/${comment.id}`,
        (patch) => {
          comment.body = (patch.body as { body: string }).body;
          return { data: commentJson(issue, comment) };
        },
      );
      return { status: 201, data: commentJson(issue, comment) };
    });
    return issue;
  }
  github.routes.set("POST /graphql", (request) => answerGraphql(world, request));
  return world;
}

function inRepository(world: FakeWorld, name: string) {
  return [...world.issues.values()].filter(
    (issue) => `${issue.owner}/${issue.repo}` === name && !issue.pullRequest,
  );
}

function answerGraphql(world: FakeWorld, request: FakeRequest): FakeResponse {
  const { variables } = request.body as {
    variables: { owner: string; repo: string; number?: number };
  };
  const name = `${variables.owner}/${variables.repo}`;
  const answer = (data: unknown) => ({ data: { data } });
  const labels = (issue: WorldIssue) =>
    list(issue.labels.map((label) => ({ name: label })));
  switch (operationOf(request.body)) {
    case "RequestOrigins": {
      const request = world.get(`${name}#${variables.number}`);
      const sources = [...world.issues.values()].filter(
        (issue) =>
          issue.crossReferenced &&
          issue.body.includes(world.url(request)) &&
          issue !== request,
      );
      return answer({
        repository: {
          issue: {
            timelineItems: page(
              sources.map((issue) => ({
                __typename: "CrossReferencedEvent",
                source: {
                  __typename: "Issue",
                  number: issue.number,
                  url: world.url(issue),
                  title: issue.title,
                  body: issue.body,
                  state: issue.state.toUpperCase(),
                  stateReason: issue.stateReason?.toUpperCase() ?? null,
                  repository: { nameWithOwner: `${issue.owner}/${issue.repo}` },
                  labels: labels(issue),
                  assignees: list(issue.assignees.map((login) => ({ login }))),
                },
              })),
            ),
          },
        },
      });
    }
    case "RepositoryOpenIssues":
      return answer({
        repository: {
          visibility: world.visibility.get(name) ?? "PUBLIC",
          issues: page(
            inRepository(world, name)
              .filter((issue) => issue.state === "open")
              .map((issue) => ({
                number: issue.number,
                url: world.url(issue),
                title: issue.title,
                body: issue.body,
                labels: labels(issue),
                assignees: list(issue.assignees.map((login) => ({ login }))),
                issueDependenciesSummary: { totalBlockedBy: issue.blockedBy.length },
                blockedBy: {
                  nodes: issue.blockedBy.map((key) => {
                    const blocker = world.get(key);
                    return {
                      url: world.url(blocker),
                      state: blocker.state.toUpperCase(),
                    };
                  }),
                },
              })),
          ),
        },
      });
    case "RepositoryClosedIssues":
      return answer({
        repository: {
          issues: page(
            inRepository(world, name)
              .filter((issue) => issue.state === "closed")
              .map((issue) => ({
                number: issue.number,
                url: world.url(issue),
                title: issue.title,
                stateReason: issue.stateReason?.toUpperCase() ?? null,
                labels: labels(issue),
              })),
          ),
        },
      });
    default:
      return answer({ repository: { pullRequests: page([]) } });
  }
}
