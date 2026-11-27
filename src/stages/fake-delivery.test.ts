// Shared test support for the Deliver stage: a fake GitHub whose branches are the
// refs of a local bare remote, plus fake agents and recorded Git calls. It holds no
// tests of its own.
import { watch } from "node:fs";
import { join } from "node:path";
import type { NibfinConfig } from "../config/index.ts";
import { type FakeRequest, paged } from "../github/fake-github.test.ts";
import { checkRun, workflowRun } from "../github/fixtures.test.ts";
import type { JobContext } from "./context.ts";
import { type DeliverDeps, runDeliverStage } from "./deliver.ts";
import { type GitFixture, makeGitFixture, recordingGit } from "./fake-git.test.ts";
import {
  type AgentStep,
  type FakeComment,
  fakeDeps,
  type FakeDeps,
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  type FakeIssues,
  jobContext,
  seedComment,
} from "./fake-job.test.ts";
import type { GitCall, GitOutput } from "./git.ts";

export const branch = "nibfin/issue-1";
export const shapeText = "## Plan\nAdd the widget.";

export interface FakePull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head: string;
  sha: string;
  mergeSha: string | null;
  title?: string;
  body?: string;
  base?: string;
  /** GitHub's `mergeable` of the pull request itself; `true` when left out. */
  mergeable?: boolean | null;
}

export interface DeliveryWorld {
  fixture: GitFixture;
  issues: FakeIssues;
  pulls: FakePull[];
  /** Required check contexts of `main`. */
  required: string[];
  /** Check runs by head SHA. */
  checkRuns: Map<string, unknown[]>;
  /** Push runs of merge commits (CD). */
  pushRuns: unknown[];
  /** In-progress runs of the execution repository. */
  runnerRuns: unknown[];
  /** Comments on pull requests, by number. */
  pullComments: Map<number, FakeComment[]>;
  /** The pull requests GitHub associates with a commit, by SHA. */
  commitPulls: Map<string, unknown[]>;
  agent: FakeDeps;
  git: ReturnType<typeof recordingGit>;
  deps: DeliverDeps;
  context: JobContext;
  nextFile: string;
  /** The waits between mergeability reads, in milliseconds. */
  waits: number[];
  /** Resolves once a log line matching `pattern` was written. */
  waitForLog(pattern: RegExp): Promise<void>;
  run(): Promise<number>;
}

function pullJson(pull: FakePull) {
  return {
    number: pull.number,
    state: pull.state,
    merged_at: pull.merged ? "2026-11-23T00:00:00Z" : null,
    head: { ref: pull.head, sha: pull.sha },
    base: { ref: pull.base ?? "main" },
    merge_commit_sha: pull.mergeSha,
    updated_at: "2026-11-23T00:00:00Z",
    html_url: `https://github.com/acme/app/pull/${pull.number}`,
    title: pull.title ?? "",
    body: pull.body ?? "",
  };
}

function routePulls(world: DeliveryWorld) {
  const { routes } = world.issues.github;
  routes.set("GET /repos/acme/app/pulls", (request) => {
    const head = request.query.get("head")?.replace(/^acme:/, "");
    const state = request.query.get("state");
    // Without `head`, the repository's pull requests (most recently updated first,
    // which here is newest first).
    const items = world.pulls
      .filter((pull) => head === undefined || pull.head === head)
      .filter((pull) => state === null || state === "all" || pull.state === state)
      .toSorted((a, b) => b.number - a.number)
      .map(pullJson);
    return paged(items)(request);
  });
  routes.set("POST /repos/acme/app/pulls", (request) => {
    const body = request.body as {
      head: string;
      base: string;
      title: string;
      body: string;
    };
    const pull: FakePull = {
      number: 100 + world.pulls.length,
      state: "open",
      merged: false,
      head: body.head,
      sha: world.fixture.remoteHead(body.head) ?? "missing",
      mergeSha: null,
      title: body.title,
      body: body.body,
      base: body.base,
    };
    world.pulls.push(pull);
    return { status: 201, data: pullJson(pull) };
  });
}

function routeBranches(world: DeliveryWorld) {
  const { routes } = world.issues.github;
  for (const name of [branch, `${branch}-cd-1`, `${branch}-cd-2`, `${branch}-cd-3`]) {
    routes.set(`GET /repos/acme/app/git/ref/heads/${name}`, () => {
      const sha = world.fixture.remoteHead(name);
      return sha === undefined
        ? { status: 404, data: { message: "Not Found" } }
        : { data: { ref: `refs/heads/${name}`, object: { sha } } };
    });
  }
}

/**
 * Answers a path the table does not hold: per-SHA checks and pull requests, single
 * pull requests and per-PR comments.
 */
function dynamicRoute(world: DeliveryWorld, request: FakeRequest) {
  const single = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(request.path);
  const found = world.pulls.find((pull) => pull.number === Number(single?.[1]));
  if (found) {
    const mergeable = found.mergeable === undefined ? true : found.mergeable;
    return { data: { ...pullJson(found), mergeable, mergeable_state: "clean" } };
  }
  const commit = /^\/repos\/acme\/app\/git\/commits\/([^/]+)$/.exec(request.path);
  if (commit) {
    return { data: { sha: commit[1], committer: { date: "2026-11-23T00:00:00Z" } } };
  }
  const commitPulls = /^\/repos\/acme\/app\/commits\/([^/]+)\/pulls$/.exec(request.path);
  if (commitPulls) {
    return paged(world.commitPulls.get(commitPulls[1]) ?? [])(request);
  }
  const workflowRuns = /^\/repos\/acme\/app\/actions\/workflows\/(\d+)\/runs$/.exec(
    request.path,
  );
  if (workflowRuns) {
    return paged(
      workflowRunsOf(world, Number(workflowRuns[1]), request),
      "workflow_runs",
    )(request);
  }
  const checks = /^\/repos\/acme\/app\/commits\/([^/]+)\/check-runs$/.exec(request.path);
  if (checks) {
    return paged(world.checkRuns.get(checks[1]) ?? [], "check_runs")(request);
  }
  if (/^\/repos\/acme\/app\/commits\/[^/]+\/statuses$/.test(request.path)) {
    return paged([])(request);
  }
  const comments = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(request.path);
  if (comments && Number(comments[1]) !== 1) {
    const number = Number(comments[1]);
    const list = world.pullComments.get(number) ?? [];
    const json = list.map((comment) => ({
      id: comment.id,
      user: { id: comment.userId, login: "x" },
      body: comment.body,
      html_url: `https://github.com/acme/app/pull/${number}#issuecomment-${comment.id}`,
    }));
    return paged(json)(request);
  }
  return undefined;
}

/** The push runs of workflow `id`, filtered by `event` and `branch` like GitHub. */
function workflowRunsOf(world: DeliveryWorld, id: number, request: FakeRequest) {
  const event = request.query.get("event");
  const branch = request.query.get("branch");
  return world.pushRuns.filter((run) => {
    const { workflow_id, head_branch } = run as {
      workflow_id?: number;
      head_branch: string;
    };
    return (
      workflow_id === id &&
      (event === null || event === "push") &&
      (branch === null || head_branch === branch)
    );
  });
}

function routeRuns(world: DeliveryWorld) {
  const { routes } = world.issues.github;
  routes.set("GET /repos/acme/app/rules/branches/main", (request) =>
    paged(
      world.required.length === 0
        ? []
        : [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: world.required.map((context) => ({ context })),
              },
            },
          ],
    )(request),
  );
  routes.set("GET /repos/acme/app/actions/runs", (request) => {
    const sha = request.query.get("head_sha");
    const runs =
      request.query.get("event") === "push"
        ? world.pushRuns.filter((run) => (run as { head_sha: string }).head_sha === sha)
        : [];
    return paged(runs, "workflow_runs")(request);
  });
  routes.set("GET /repos/acme/runner/actions/runs", (request) =>
    paged(world.runnerRuns, "workflow_runs")(request),
  );
}

export interface WorldOptions {
  steps?: AgentStep[];
  issue?: Partial<FakeIssue>;
  /** Leaves the Issue without a marked Shape comment. */
  noShape?: boolean;
  override?: (call: GitCall) => GitOutput | undefined;
  reason?: JobContext["reason"];
  /** The `.nibfin.json` the stage reads; the fake default otherwise. */
  config?: NibfinConfig;
}

export async function deliveryWorld(options: WorldOptions = {}): Promise<DeliveryWorld> {
  const fixture = await makeGitFixture("deliver-");
  const main = fakeIssue({ labels: ["scope", "shaped"], ...options.issue });
  const issues = fakeIssues(main);
  if (!options.noShape) {
    seedComment(issues, main, `<!-- nibfin:shape -->\n${shapeText}`);
  }
  const agent = fakeDeps(options.steps ?? [], options.config);
  const listeners: Array<() => void> = [];
  const log = agent.deps.log;
  agent.deps.log = (line) => {
    log(line);
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const git = recordingGit(options.override);
  const nextFile = join(fixture.root, "next.json");
  const waits: number[] = [];
  const context: JobContext = {
    ...jobContext(fixture.workspace),
    runRepo: { owner: "acme", repo: "runner" },
    runId: 900,
    nextFile,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
  const deps: DeliverDeps = {
    ...agent.deps,
    runGit: git.run,
    remoteUrl: () => fixture.remote,
    coreRepoParent: fixture.root,
    watch,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  const world: DeliveryWorld = {
    fixture,
    issues,
    pulls: [],
    required: [],
    checkRuns: new Map(),
    pushRuns: [],
    runnerRuns: [],
    pullComments: new Map(),
    commitPulls: new Map(),
    agent,
    git,
    deps,
    context,
    nextFile,
    waits,
    waitForLog: (pattern) =>
      new Promise((resolve) => {
        const listener = () => {
          if (agent.logs.some((line) => pattern.test(line))) {
            listeners.splice(listeners.indexOf(listener), 1);
            resolve();
          }
        };
        listeners.push(listener);
        listener();
      }),
    run: () => runDeliverStage(world.context, issues.github.client, world.deps),
  };
  routePulls(world);
  routeBranches(world);
  routeRuns(world);
  const fallback = issues.github.routes;
  const original = fallback.get.bind(fallback);
  fallback.get = (key: string) =>
    original(key) ??
    (key.startsWith("GET ")
      ? (request: FakeRequest) =>
          dynamicRoute(world, request) ?? { status: 404, data: { message: "Not Found" } }
      : undefined);
  return world;
}

/** A failed GitHub Actions check run of `context` on `sha`. */
export function failedActionsCheck(id: number, context: string) {
  return checkRun(id, context, { conclusion: "failure", slug: "github-actions" });
}

/** A merged pull request whose CD failed, with Nibfin's own push run present. */
export function failedCd(world: DeliveryWorld, number = 5) {
  world.pulls.push({
    number,
    state: "closed",
    merged: true,
    head: branch,
    sha: `head-${number}`,
    mergeSha: `merge-${number}`,
  });
  world.pushRuns.push(
    workflowRun(1, { name: "Nibfin · events", sha: `merge-${number}` }),
    workflowRun(2, { name: "CD", conclusion: "failure", sha: `merge-${number}` }),
  );
}
