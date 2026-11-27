import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { type FakeRequest, failure, rejection } from "../github/fake-github.test.ts";
import { operationOf } from "../github/fake-issue-record.test.ts";
import { GitHubError } from "../github/index.ts";
import { StageError } from "./errors.ts";
import {
  agentResult,
  type AgentStep,
  answerCommentQuery,
  fakeDeps,
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  jobContext,
  makeCommittedWorkspace,
  seedComment,
} from "./fake-job.test.ts";
import { publishRequestPlan } from "./scope-publish.ts";
import {
  defaultScopeDeps,
  type PublishOutcome,
  type PublishScope,
  type RequestPlan,
  runScopeStage,
  type ScopeDeps,
} from "./scope.ts";

let workspace: string;
before(async () => {
  workspace = await makeCommittedWorkspace("scope-");
});

const requestUrl = "https://github.com/acme/app/issues/1";
const marker = "<!-- nibfin:scope-request -->";
const ownUrl = "https://github.com/acme/lib/issues/7";

const page = <T>(nodes: T[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});
const list = <T>(nodes: T[]) => ({ totalCount: nodes.length, nodes });

interface World {
  visibility: Record<string, string>;
  /** Whether each `owner/repo:login` can be assigned; unlisted logins can. */
  unassignable: Set<string>;
  /** The request's own Issue on acme/lib, if any. */
  origin: "open" | "closed" | false;
}

/** acme/lib holds an open and a closed Issue and an open pull request; acme/app none. */
const lib = (repository: string) => repository === "acme/lib";

function openIssues(repository: string, world: World) {
  const nodes = lib(repository)
    ? [
        {
          number: 50,
          url: "https://github.com/acme/lib/issues/50",
          title: "Existing work in lib",
          body: "Existing body",
          labels: list([{ name: "scope" }]),
          assignees: list([{ login: "taco" }]),
          issueDependenciesSummary: { totalBlockedBy: 1 },
          blockedBy: {
            nodes: [{ url: "https://github.com/acme/lib/issues/49", state: "OPEN" }],
          },
        },
      ]
    : [];
  return { visibility: world.visibility[repository], issues: page(nodes) };
}

function closedIssues(repository: string) {
  const nodes = lib(repository)
    ? [
        {
          number: 48,
          url: "https://github.com/acme/lib/issues/48",
          title: "Old work",
          stateReason: "COMPLETED",
          labels: list([{ name: "delivered" }]),
        },
        {
          number: 47,
          url: "https://github.com/acme/lib/issues/47",
          title: "Older work",
          stateReason: null,
          labels: list([]),
        },
      ]
    : [];
  return { issues: page(nodes) };
}

function openPulls(repository: string) {
  const nodes = lib(repository)
    ? [
        {
          number: 51,
          url: "https://github.com/acme/lib/pull/51",
          title: "Fix lib",
          headRefName: "nibfin/issue-50",
        },
      ]
    : [];
  return { pullRequests: page(nodes) };
}

/** The scope stage's GraphQL reads; the comment query as the stage fakes answer it. */
function graphql(world: World, main: FakeIssue) {
  return (request: FakeRequest) => {
    const operation = operationOf(request.body);
    const { variables } = request.body as {
      variables: { owner: string; repo: string };
    };
    const repository = `${variables.owner}/${variables.repo}`;
    const answer = (data: unknown) => ({ data: { data } });
    switch (operation) {
      case "RequestOrigins":
        return answer({
          repository: {
            issue: {
              timelineItems: page(
                world.origin !== false
                  ? [
                      {
                        __typename: "CrossReferencedEvent",
                        source: {
                          __typename: "Issue",
                          number: 7,
                          url: ownUrl,
                          title: "Earlier part",
                          body: `Part.\nOrigin: ${requestUrl}`,
                          state: world.origin === "closed" ? "CLOSED" : "OPEN",
                          stateReason: world.origin === "closed" ? "COMPLETED" : null,
                          repository: { nameWithOwner: "acme/lib" },
                          labels: list([]),
                          assignees: list([]),
                        },
                      },
                    ]
                  : [],
              ),
            },
          },
        });
      case "RepositoryOpenIssues":
        return answer({ repository: openIssues(repository, world) });
      case "RepositoryClosedIssues":
        return answer({ repository: closedIssues(repository) });
      case "RepositoryOpenPulls":
        return answer({ repository: openPulls(repository) });
      default:
        return answerCommentQuery([main], request);
    }
  };
}

function setup(
  steps: AgentStep[],
  overrides: Partial<FakeIssue> = {},
  worldOverrides: Partial<World> = {},
) {
  const main = fakeIssue({ labels: ["request"], title: "Please add X", ...overrides });
  const issues = fakeIssues(main);
  const world: World = {
    visibility: { "acme/app": "PUBLIC", "acme/lib": "PRIVATE" },
    unassignable: new Set(),
    origin: false,
    ...worldOverrides,
  };
  const { github } = issues;
  github.routes.set("POST /graphql", graphql(world, main));
  github.routes.set("PATCH /repos/acme/app/issues/1", (request) => {
    const { state } = request.body as { state: "closed" };
    main.state = state;
    return { data: {} };
  });
  for (const repository of ["acme/app", "acme/lib"]) {
    github.routes.set(`GET /repos/${repository}/assignees/taco`, () =>
      world.unassignable.has(`${repository}:taco`)
        ? failure(404, "Not Found")
        : { status: 204 },
    );
  }
  const fake = fakeDeps(steps);
  const published: Array<{ scope: PublishScope; plan: RequestPlan }> = [];
  /** What the stubbed publication does; it records its call and stops by default. */
  const outcomes: Array<(scope: PublishScope) => Promise<PublishOutcome>> = [];
  const deps: ScopeDeps = {
    ...fake.deps,
    publish: (scope, plan) => {
      published.push({ scope, plan });
      const next = outcomes.shift();
      return next === undefined ? Promise.resolve({ kind: "stopped" }) : next(scope);
    },
  };
  const context = {
    ...jobContext(workspace),
    runRepo: { owner: "acme", repo: "runner" },
    runId: 900,
  };
  const run = () => runScopeStage(context, github.client, deps);
  return { issues, main, world, fake, deps, published, outcomes, run };
}

const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];

const feasible = agentResult({
  outcome: "feasible",
  reason: "Feasible in acme/lib's parser.",
  repositories: ["acme/lib"],
});
const newIssue = {
  key: "parser",
  repository: "acme/lib",
  title: "Add the X parser",
  body: `Parse X.\n\nOrigin: ${requestUrl}`,
  blockedBy: [],
};
const planReady = (deduplication = "verified") =>
  agentResult({
    outcome: "PLAN_READY",
    deduplication,
    report: "## Plan\nOne Issue.",
    issues: [newIssue],
  });

describe("runScopeStage eligibility", () => {
  for (const [name, overrides, expected] of [
    ["scope", { labels: ["request", "scope"] }, "shape"],
    ["pending", { labels: ["request", "pending"] }, "ineligible (pending)"],
    ["paused", { labels: ["request", "pause"] }, "ineligible (paused)"],
    ["closed", { state: "closed" }, "ineligible (closed)"],
    ["unassigned", { assignees: [] }, "ineligible (no-assignee)"],
  ] as Array<[string, Partial<FakeIssue>, string]>) {
    it(`runs nothing for a ${name} request`, async () => {
      const t = setup([], overrides);
      assert.equal(await t.run(), 0);
      assert.deepEqual(t.fake.logs, [
        `acme/app#1 is not at the scope stage: ${expected}`,
      ]);
      assert.deepEqual(t.fake.runs, []);
      assert.deepEqual(t.fake.configReads, []);
      assert.deepEqual(t.issues.github.writes(), []);
    });
  }

  it("uses the default publication when no deps are given", () => {
    assert.equal(defaultScopeDeps.publish, publishRequestPlan);
  });
});

describe("runScopeStage Investigation", () => {
  it("closes an already covered request as not planned with one comment", async () => {
    const covering = "https://github.com/acme/app/issues/9";
    const t = setup([
      agentResult({
        outcome: "already-covered",
        reason: "main already parses X.",
        covering,
      }),
    ]);
    assert.equal(await t.run(), 0);
    const [comment] = t.issues.marked("scope-request");
    assert.equal(t.issues.marked("scope-request").length, 1);
    assert.match(comment.body, /already covered, so it is closed as not planned/);
    assert.match(comment.body, new RegExp(`Covering Issue: ${covering}`));
    assert.match(comment.body, /main already parses X\./);
    assert.equal(t.main.state, "closed");
    assert.ok(!t.main.labels.includes("pending"));
    const close = t.issues.github.writes().find((call) => call.method === "PATCH");
    assert.deepEqual(close?.body, { state: "closed", state_reason: "not_planned" });
    assert.equal(t.fake.runs.length, 1);
    const [run] = t.fake.runs;
    assert.equal(roleOf(run.prompt), "Investigation");
    assert.match(run.prompt, /^SKILL TEXT OF shape/);
    assert.match(
      run.prompt,
      /## Visibility\n\n- acme\/app \(the request repository\): public/,
    );
    assert.match(run.prompt, /## Inventory of acme\/app \(public\)/);
    assert.match(run.prompt, /Title: Please add X/);
    assert.doesNotMatch(run.prompt, /ghs_fake/);
    assert.deepEqual(t.fake.skillReads, ["shape", "scope"]);
  });

  it("stops before the close when paused after the comment", async () => {
    const covered = agentResult({
      outcome: "already-covered",
      reason: "Done in main.",
      covering: null,
    });
    const t = setup([covered]);
    const route = "POST /repos/acme/app/issues/1/comments";
    const post = t.issues.github.routes.get(route) as (r: FakeRequest) => unknown;
    t.issues.github.routes.set(route, (request) => {
      t.main.labels.push("pause");
      return post(request) as never;
    });
    assert.equal(await t.run(), 0);
    const [comment] = t.issues.marked("scope-request");
    assert.doesNotMatch(comment.body, /Covering Issue/);
    assert.equal(t.main.state, "open");
    assert.equal(
      t.fake.logs.at(-1),
      "acme/app#1 is not at the scope stage: ineligible (paused)",
    );
  });

  for (const [outcome, verdict, state, listed] of [
    ["not-feasible", "Not feasible", "closed", "closed, completed"],
    ["needs-person", "Needs a person", "open", "open"],
  ] as const) {
    it(`adds pending with one comment when ${outcome}`, async () => {
      const t = setup(
        [agentResult({ outcome, reason: "R3.9 needs an Owner call." })],
        {},
        {
          origin: state,
        },
      );
      assert.equal(await t.run(), 0);
      const [comment] = t.issues.marked("scope-request");
      assert.match(comment.body, /Only a person can decide/);
      assert.match(comment.body, new RegExp(`Judgment: ${verdict}`));
      assert.match(comment.body, /R3\.9 needs an Owner call\./);
      assert.ok(comment.body.includes(`- ${ownUrl} (${listed})`));
      assert.match(comment.body, /remove `pending`; the Scope stage then starts again/);
      assert.ok(t.main.labels.includes("pending"));
      assert.equal(t.main.state, "open");
      assert.equal(t.fake.runs.length, 1);
      assert.match(
        t.fake.runs[0].prompt,
        /## The request's own Issues\n\n### https:\/\/github.com\/acme\/lib\/issues\/7/,
      );
    });
  }

  it("updates the same comment on a redo", async () => {
    const t = setup([agentResult({ outcome: "not-feasible", reason: "New reason" })]);
    seedComment(t.issues, t.main, `${marker}\nOld reason`);
    assert.equal(await t.run(), 0);
    const comments = t.issues.marked("scope-request");
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /New reason/);
    assert.match(comments[0].body, /None yet\./);
  });

  it("stops without writing when pause or pending is added during the run", async () => {
    for (const label of ["pause", "pending"]) {
      const t = setup([]);
      t.fake.deps.runAgent = async (options) => {
        await options.beforeStart?.();
        t.main.labels.push(label);
        return {
          exitCode: 0,
          finalMessage: agentResult({ outcome: "not-feasible", reason: "x" }),
        };
      };
      const deps = { ...t.deps, runAgent: t.fake.deps.runAgent };
      assert.equal(
        await runScopeStage(jobContext(workspace), t.issues.github.client, deps),
        0,
      );
      assert.deepEqual(t.issues.github.writes(), []);
    }
  });

  it("investigates again after the request is edited during the run", async () => {
    const t = setup([
      () => {
        t.main.body = "Now asks for Y.";
        return agentResult({ outcome: "not-feasible", reason: "X is impossible" });
      },
      agentResult({ outcome: "needs-person", reason: "Y needs a decision" }),
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.fake.runs.length, 2);
    assert.ok(t.fake.runs.every((run) => roleOf(run.prompt) === "Investigation"));
    assert.match(t.fake.runs[1].prompt, /Now asks for Y\./);
    assert.ok(t.fake.logs.includes("Round 1: the request changed; investigating again"));
    assert.match(t.issues.marked("scope-request")[0].body, /Y needs a decision/);
  });

  it("fails an invalid result before any write", async () => {
    const t = setup([agentResult({ outcome: "feasible", reason: "x" })]);
    const error = await rejection(t.run());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_RESULT_INVALID");
    assert.deepEqual(t.issues.github.writes(), []);
  });
});

describe("runScopeStage Plan", () => {
  it("hands a verified PLAN_READY plan to publication without writing", async () => {
    const t = setup([feasible, planReady()], { body: "" }, { origin: "open" });
    t.world.unassignable.add("acme/lib:taco");
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.issues.github.writes(), []);
    assert.equal(t.published.length, 1);
    const [{ scope, plan }] = t.published;
    assert.deepEqual(scope.issue, { owner: "acme", repo: "app", number: 1 });
    assert.deepEqual(plan, {
      request: requestUrl,
      investigation: "Feasible in acme/lib's parser.",
      report: "## Plan\nOne Issue.",
      issues: [newIssue],
    });
    const [, planRun] = t.fake.runs;
    assert.equal(roleOf(planRun.prompt), "Plan");
    assert.match(planRun.prompt, /^SKILL TEXT OF scope/);
    const lines = [
      "## Visibility\n\n- acme/app (the request repository): public\n- acme/lib: private",
      "## Inventory of acme/lib (private)",
      "Existing work in lib",
      "Blocked by: https://github.com/acme/lib/issues/49 (open)",
      "- https://github.com/acme/lib/issues/48 (closed (completed)): Old work " +
        "[labels: delivered]",
      "- https://github.com/acme/lib/issues/47 (closed): Older work [labels: none]",
      "- https://github.com/acme/lib/pull/51 (head nibfin/issue-50): Fix lib",
      "## Inventory of acme/app (public)\n\nVisibility: public\n\n" +
        "### Open Issues\n\nNone.",
      "Title: Please add X\nAssignees: taco\n\n(no description)",
      "State: open\nTitle: Earlier part",
    ];
    for (const line of lines) {
      assert.ok(planRun.prompt.includes(line), line);
    }
    assert.match(
      planRun.prompt,
      /## Investigation judgment: feasible\n\nFeasible in acme\/lib's parser\./,
    );
    assert.match(
      planRun.prompt,
      /- taco in acme\/app: assignable\n- taco in acme\/lib: not assignable/,
    );
    const assigneeCalls = t.issues.github.calls.filter((call) =>
      call.path.includes("/assignees/"),
    );
    assert.equal(assigneeCalls.length, 2);
    assert.deepEqual(t.issues.github.waits, []);
  });

  for (const [name, message, verdict] of [
    [
      "PLAN_BLOCKED",
      agentResult({ outcome: "PLAN_BLOCKED", reason: "Gap" }),
      "PLAN_BLOCKED",
    ],
    [
      "AUTHORITY_UPDATE_REQUIRED",
      agentResult({ outcome: "AUTHORITY_UPDATE_REQUIRED", reason: "Gap" }),
      "AUTHORITY_UPDATE_REQUIRED",
    ],
    [
      "unverified deduplication",
      planReady("unverified"),
      "PLAN_READY without verified deduplication",
    ],
  ]) {
    it(`adds pending for ${name}`, async () => {
      const t = setup([feasible, message]);
      assert.equal(await t.run(), 0);
      assert.equal(t.published.length, 0);
      assert.ok(t.main.labels.includes("pending"));
      const [comment] = t.issues.marked("scope-request");
      assert.ok(comment.body.includes(`Judgment: ${verdict}`));
    });
  }

  it("rejects a plan for a repository the stage did not read", async () => {
    const plan = agentResult({
      outcome: "PLAN_READY",
      deduplication: "verified",
      report: "r",
      issues: [{ ...newIssue, repository: "acme/other" }],
    });
    const t = setup([feasible, plan]);
    const error = await rejection(t.run());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_RESULT_INVALID");
    assert.equal(t.published.length, 0);
  });

  it("stops before publishing when pending is added during the Plan", async () => {
    const t = setup([
      feasible,
      () => {
        t.main.labels.push("pending");
        return planReady();
      },
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.published.length, 0);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("fails the run when pending is not read back", async () => {
    const t = setup([feasible, agentResult({ outcome: "PLAN_BLOCKED", reason: "Gap" })]);
    t.issues.github.routes.set("POST /repos/acme/app/issues/1/labels", { data: [] });
    const error = await rejection(t.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
  });
});

describe("runScopeStage publication", () => {
  const runUrl = "https://github.com/acme/runner/actions/runs/900";
  const createdUrl = "https://github.com/acme/lib/issues/60";
  const published = [{ key: "parser", url: createdUrl }];
  const unconfirmed = new GitHubError(
    "GITHUB_WRITE_UNCONFIRMED",
    "add scope to " + createdUrl,
    new Error("The read-back labels lack scope"),
  );

  it("hands publication the request, its Assignees and a re-check", async () => {
    const t = setup([feasible, planReady()]);
    const checks: string[] = [];
    t.outcomes.push(async (scope) => {
      checks.push(await scope.recheck());
      t.main.labels.push("pause");
      checks.push(await scope.recheck());
      return { kind: "stopped" };
    });
    assert.equal(await t.run(), 0);
    const [{ scope }] = t.published;
    assert.deepEqual(scope.issue, { owner: "acme", repo: "app", number: 1 });
    assert.deepEqual(scope.assignees, ["taco"]);
    assert.deepEqual(checks, ["scope", "stopped"]);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("ends without further writes when published", async () => {
    const t = setup([feasible, planReady()]);
    t.outcomes.push(() => Promise.resolve({ kind: "published", published }));
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.issues.github.writes(), []);
    assert.deepEqual(t.issues.marked("pending"), []);
  });

  it("investigates again when the request is edited during publication", async () => {
    const t = setup([
      feasible,
      planReady(),
      agentResult({ outcome: "needs-person", reason: "Y needs a decision" }),
    ]);
    t.outcomes.push(async (scope) => {
      t.main.body = "Now asks for Y.";
      return { kind: await scope.recheck() } as PublishOutcome;
    });
    assert.equal(await t.run(), 0);
    assert.equal(t.fake.runs.length, 3);
    assert.equal(roleOf(t.fake.runs[2].prompt), "Investigation");
    assert.match(t.fake.runs[2].prompt, /Now asks for Y\./);
    assert.ok(t.fake.logs.includes("Round 1: the request changed; investigating again"));
    assert.match(t.issues.marked("scope-request")[0].body, /Y needs a decision/);
  });

  it("adds pending with the verdict and the Issues for a replan", async () => {
    const t = setup([feasible, planReady()], {}, { origin: "open" });
    t.outcomes.push(() =>
      Promise.resolve({
        kind: "person",
        verdict: "REPLAN_REQUIRED",
        reason: "An Issue is not in the plan.",
        published,
      }),
    );
    assert.equal(await t.run(), 0);
    const [comment] = t.issues.marked("scope-request");
    assert.ok(comment.body.includes("Judgment: REPLAN_REQUIRED"));
    assert.ok(comment.body.includes("An Issue is not in the plan."));
    assert.ok(comment.body.includes("Issues published so far:\n- parser: " + createdUrl));
    assert.ok(comment.body.includes("- " + ownUrl + " (open)"));
    assert.doesNotMatch(comment.body, /Code:/);
    assert.ok(t.main.labels.includes("pending"));
    assert.deepEqual(t.issues.marked("pending"), []);
  });

  it("logs the failure, comments once, adds pending and exits 1", async () => {
    const t = setup([feasible, planReady()]);
    t.outcomes.push(() =>
      Promise.resolve({
        kind: "person",
        verdict: "PARTIAL_PUBLICATION",
        reason: unconfirmed.message,
        published,
        error: unconfirmed,
      }),
    );
    assert.equal(await t.run(), 1);
    assert.ok(
      t.fake.logs.includes("nibfin: GITHUB_WRITE_UNCONFIRMED: " + unconfirmed.message),
    );
    const comments = t.issues.marked("scope-request");
    assert.equal(comments.length, 1);
    const { body } = comments[0];
    assert.ok(body.includes("Judgment: PARTIAL_PUBLICATION"));
    assert.ok(body.includes("Issues published so far:\n- parser: " + createdUrl));
    assert.ok(body.includes("- Code: `GITHUB_WRITE_UNCONFIRMED`"));
    assert.ok(body.includes("- Run: " + runUrl));
    assert.ok(body.includes("```text\n" + unconfirmed.message + "\n```"));
    assert.match(body, /This looks temporary .*removing the label retries it/s);
    assert.ok(t.main.labels.includes("pending"));
    assert.deepEqual(t.issues.marked("pending"), []);
  });

  it("writes a rejected failure comment again without the message", async () => {
    const t = setup([feasible, planReady()]);
    t.outcomes.push(() =>
      Promise.resolve({
        kind: "person",
        verdict: "PUBLICATION_BLOCKED",
        reason: "r",
        published: [],
        error: unconfirmed,
      }),
    );
    const route = "POST /repos/acme/app/issues/1/comments";
    const post = t.issues.github.routes.get(route) as (r: FakeRequest) => unknown;
    t.issues.github.routes.set(route, (request) =>
      (request.body as { body: string }).body.includes("```text")
        ? failure(422, "Body is too long")
        : (post(request) as never),
    );
    assert.equal(await t.run(), 1);
    const [comment] = t.issues.marked("scope-request");
    assert.ok(comment.body.includes("The full message is in the run log."));
    assert.ok(comment.body.includes("Issues published so far:\nNone."));
    assert.ok(t.main.labels.includes("pending"));
  });

  it("throws the original failure when its comment cannot be written", async () => {
    const t = setup([feasible, planReady()]);
    t.outcomes.push(() =>
      Promise.resolve({
        kind: "person",
        verdict: "PARTIAL_PUBLICATION",
        reason: "r",
        published,
        error: unconfirmed,
      }),
    );
    t.issues.github.routes.set("POST /repos/acme/app/issues/1/comments", failure(500));
    const error = await rejection(t.run());
    assert.equal(error, unconfirmed);
    assert.ok(
      t.fake.logs.some((line) => line.startsWith("nibfin: could not ask a person: ")),
    );
    assert.ok(!t.main.labels.includes("pending"));
  });
});
