// Shared test support for the review stage: the Deliver test world (fake GitHub,
// fake agents, a local bare remote) plus the merge, review, closing and wake routes.
// It holds no tests of its own.
import { readFileSync } from "node:fs";
import {
  type FakeRequest,
  type FakeResponse,
  fakeActor,
  paged,
} from "../github/fake-github.test.ts";
import { workflowRun } from "../github/fixtures.test.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  type FakePull,
  type WorldOptions,
} from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import {
  type FakeComment,
  fakeIssue,
  type FakeIssue,
  routeIssue,
} from "./fake-job.test.ts";
import { runReviewStage } from "./review.ts";
import type { ReviewDeps } from "./review-scope.ts";

export interface ReviewWorld extends DeliveryWorld {
  /** The open pull request under review and its head, a real commit of the remote. */
  pull: FakePull;
  head: string;
  mergeable: boolean | null;
  mergeableState: string;
  settings: Record<string, boolean | undefined>;
  /** Extra rules of `main` besides its required checks. */
  rules: unknown[];
  reviews: unknown[];
  /** Commits of each pull request; its head alone when unset. */
  pullCommits: Map<number, string[]>;
  /** Versions (`userContentEdits.totalCount`) by comment id. */
  edits: Map<number, number>;
  /** Answers the merge; merges the pull request when unset. */
  mergeAnswer: ((request: FakeRequest) => FakeResponse) | undefined;
  /** Issues `acme/app#1` blocks; set before the run. */
  blocking: FakeIssue[];
  mergeRequests: FakeRequest[];
  reviewDeps: ReviewDeps;
  review(): Promise<number>;
  next(): unknown;
}

let nextPullCommentId = 5000;

/** Adds a comment on pull request `number` with its update route. */
export function addPullComment(
  world: DeliveryWorld,
  number: number,
  body: string,
  userId = fakeActor.id,
): FakeComment {
  const comment = { id: nextPullCommentId++, userId, body };
  const list = world.pullComments.get(number) ?? [];
  list.push(comment);
  world.pullComments.set(number, list);
  world.issues.github.routes.set(
    `PATCH /repos/acme/app/issues/comments/${comment.id}`,
    (request) => {
      comment.body = (request.body as { body: string }).body;
      return { data: { id: comment.id } };
    },
  );
  return comment;
}

function pullDetail(world: ReviewWorld, pull: FakePull) {
  return {
    number: pull.number,
    state: pull.state,
    merged_at: pull.merged ? "2026-11-23T00:00:00Z" : null,
    head: { ref: pull.head, sha: pull.sha },
    base: { ref: pull.base ?? "main" },
    merge_commit_sha: pull.mergeSha,
    html_url: `https://github.com/acme/app/pull/${pull.number}`,
    mergeable: world.mergeable,
    mergeable_state: world.mergeableState,
  };
}

/** Merges `pull` like GitHub does and lets CD start (Nibfin's run and one CD run). */
export function mergePull(world: DeliveryWorld, pull: FakePull, conclusion = "success") {
  pull.state = "closed";
  pull.merged = true;
  pull.mergeSha = `merge-${pull.number}`;
  world.pushRuns.push(
    workflowRun(10 + pull.number, { name: "Nibfin · events", sha: pull.mergeSha }),
    workflowRun(20 + pull.number, {
      name: "CD",
      path: ".github/workflows/cd.yml",
      conclusion,
      sha: pull.mergeSha,
    }),
  );
}

function routePullDetails(world: ReviewWorld) {
  const { routes } = world.issues.github;
  const pullOf = (request: FakeRequest) => {
    const number = Number(/\/pulls\/(\d+)/.exec(request.path)?.[1]);
    return world.pulls.find((candidate) => candidate.number === number);
  };
  const fallback = routes.get.bind(routes);
  routes.get = (key: string) => {
    if (/^GET \/repos\/acme\/app\/pulls\/\d+$/.test(key)) {
      return (request) => ({ data: pullDetail(world, pullOf(request)!) });
    }
    if (/^GET \/repos\/acme\/app\/pulls\/\d+\/commits$/.test(key)) {
      return (request) => {
        const pull = pullOf(request)!;
        const shas = world.pullCommits.get(pull.number) ?? [pull.sha];
        return paged(shas.map((sha) => ({ sha })))(request);
      };
    }
    if (/^GET \/repos\/acme\/app\/pulls\/\d+\/reviews$/.test(key)) {
      return (request) => paged(world.reviews)(request);
    }
    if (/^PUT \/repos\/acme\/app\/pulls\/\d+\/merge$/.test(key)) {
      return (request) => {
        world.mergeRequests.push(request);
        if (world.mergeAnswer !== undefined) {
          return world.mergeAnswer(request);
        }
        const pull = pullOf(request)!;
        mergePull(world, pull);
        return { data: { sha: pull.mergeSha, merged: true, message: "Merged" } };
      };
    }
    if (/^GET \/repos\/acme\/app\/issues\/comments\/\d+$/.test(key)) {
      const id = Number(/(\d+)$/.exec(key)?.[1]);
      return { data: { id, node_id: `IC_${id}` } };
    }
    return fallback(key) ?? pullCommentWrite(world, key);
  };
}

/** Creating a comment on a pull request (any number other than the Issue's). */
function pullCommentWrite(world: ReviewWorld, key: string) {
  const match = /^POST \/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(key);
  if (match === null) {
    return undefined;
  }
  return (request: FakeRequest) => {
    const { body } = request.body as { body: string };
    const comment = addPullComment(world, Number(match[1]), body);
    return { status: 201, data: { id: comment.id } };
  };
}

function issueUrl(issue: FakeIssue): string {
  return `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`;
}

function routeRepository(world: ReviewWorld) {
  const { routes } = world.issues.github;
  routes.set("GET /repos/acme/app", () => ({ data: world.settings }));
  const required = routes.get("GET /repos/acme/app/rules/branches/main");
  routes.set("GET /repos/acme/app/rules/branches/main", async (request) => {
    const answer = await (required as (r: FakeRequest) => Promise<FakeResponse>)({
      ...request,
      query: new URLSearchParams("per_page=100"),
    });
    return paged([...(answer.data as unknown[]), ...world.rules])(request);
  });
  routes.set("POST /graphql", (request) => {
    const { variables } = request.body as { variables: { id: string } };
    const id = Number(variables.id.slice("IC_".length));
    const totalCount = world.edits.get(id) ?? 0;
    return { data: { data: { node: { userContentEdits: { totalCount } } } } };
  });
  routes.set("PATCH /repos/acme/app/issues/1", (request) => {
    const { state } = request.body as { state: "open" | "closed" };
    world.issues.main.state = state;
    return { data: {} };
  });
  const issueRoute = routes.get("GET /repos/acme/app/issues/1") as (
    request: FakeRequest,
  ) => FakeResponse;
  routes.set("GET /repos/acme/app/issues/1", (request) => {
    const answer = issueRoute(request);
    const data = answer.data as { issue_dependencies_summary: object };
    data.issue_dependencies_summary = {
      ...data.issue_dependencies_summary,
      total_blocking: world.blocking.length,
    };
    return answer;
  });
  routes.set("GET /repos/acme/app/issues/1/dependencies/blocking", (request) =>
    paged(
      world.blocking.map((issue) => ({
        number: issue.number,
        state: issue.state,
        labels: issue.labels.map((name) => ({ name })),
        repository_url: `https://api.github.com/repos/${issue.owner}/${issue.repo}`,
        html_url: issueUrl(issue),
      })),
    )(request),
  );
}

/** A downstream Issue blocked by `acme/app#1`, routed unless it is unreadable. */
export function addDownstream(
  world: ReviewWorld,
  overrides: Partial<FakeIssue>,
  options: { readable?: boolean; blockers?: FakeIssue[] } = {},
): FakeIssue {
  const issue = fakeIssue(overrides);
  world.blocking.push(issue);
  if (options.readable ?? true) {
    routeIssue(world.issues.github, issue, options.blockers ?? [world.issues.main]);
  }
  return issue;
}

/**
 * The Deliver world with an open pull request whose head is a real commit pushed to
 * the remote, so the review can fetch and check it out.
 */
export async function reviewWorld(options: WorldOptions = {}): Promise<ReviewWorld> {
  const base = await deliveryWorld(options);
  const { fixture } = base;
  git(fixture.other, "checkout", "--quiet", "-b", branch);
  commitFile(fixture.other, "widget.txt", "widget\n", "feat: add the widget");
  git(fixture.other, "push", "--quiet", "origin", branch);
  const head = fixture.remoteHead(branch)!;
  const pull: FakePull = {
    number: 7,
    state: "open",
    merged: false,
    head: branch,
    sha: head,
    mergeSha: null,
  };
  base.pulls.push(pull);
  const world = base as ReviewWorld;
  Object.assign(world, {
    pull,
    head,
    mergeable: true,
    mergeableState: "clean",
    settings: {
      allow_rebase_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
    },
    rules: [],
    reviews: [],
    pullCommits: new Map(),
    edits: new Map(),
    mergeAnswer: undefined,
    blocking: [],
    mergeRequests: [],
  });
  world.reviewDeps = { ...base.deps };
  world.review = () =>
    runReviewStage(world.context, world.issues.github.client, world.reviewDeps);
  world.next = () => JSON.parse(readFileSync(world.nextFile, "utf8")) as unknown;
  routeRepository(world);
  routePullDetails(world);
  return world;
}
