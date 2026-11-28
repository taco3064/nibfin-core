import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, paged, rejection } from "../github/fake-github.test.ts";
import { pull as pullJson } from "../github/fixtures.test.ts";
import { type ActingClient, freshReads, GitHubError } from "../github/index.ts";
import { type NextAction, requestPerson, StageError } from "../stages/index.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  failedActionsCheck,
  failedCd,
} from "../stages/fake-delivery.test.ts";
import { commitFile, git } from "../stages/fake-git.test.ts";
import {
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  seedComment,
  shapeVersion,
  unlabel,
} from "../stages/fake-job.test.ts";
import {
  addPullComment,
  addReview,
  mergePull,
  requireApprovals,
  reviewWorld,
} from "../stages/fake-review.test.ts";
import { readLiveDecision, saveChoice } from "../stages/choice.ts";
import {
  decide,
  issueRef,
  permissions,
  writeOptionsRecord,
} from "../stages/fake-choice.test.ts";
import { shapeWrongBody } from "../stages/shape-wrong.ts";
import { readRoute, routeEvent, routeIssue } from "./route.ts";

const repo = { owner: "acme", repo: "app" };
const log = () => {};

/** A state to route: the client of its fake GitHub. */
type Build = () => Promise<ActingClient>;

function plain(overrides: Partial<FakeIssue>): Build {
  return () => Promise.resolve(fakeIssues(fakeIssue(overrides)).github.client);
}

function reportWrong(world: DeliveryWorld) {
  const body = shapeWrongBody(shapeVersion(world.issues), "It is wrong.");
  seedComment(world.issues, world.issues.main, `<!-- nibfin:shape-wrong -->\n${body}`);
}

async function delivery(change?: (world: DeliveryWorld) => void | Promise<void>) {
  const world = await deliveryWorld();
  await change?.(world);
  return world.issues.github.client;
}

/** The review world (open PR #7, no required checks), changed by `change`. */
function atReview(change?: (world: Awaited<ReturnType<typeof reviewWorld>>) => void) {
  return async () => {
    const world = await reviewWorld();
    change?.(world);
    return world.issues.github.client;
  };
}

function reviewComment(world: Awaited<ReturnType<typeof reviewWorld>>, current: boolean) {
  const shape = current ? `\nReviewed Shape: ${shapeVersion(world.issues)}` : "";
  const body = `<!-- nibfin:review -->\nReviewed head: ${world.head}${shape}\n\nFix it.`;
  addPullComment(world, 7, body);
}

/** The actor's `approval-wait` comment for `head`, under a one-approval ruleset. */
function approvalWait(world: Awaited<ReturnType<typeof reviewWorld>>, head = world.head) {
  requireApprovals(world, 1);
  const body =
    `<!-- nibfin:approval-wait -->\nReviewed head: ${head}\n` +
    `Reviewed Shape: ${shapeVersion(world.issues)}\n\nWaiting.`;
  addPullComment(world, 7, body);
}

/**
 * An options record with a writer's decision for option 2 on `issues`; `status`
 * stores it as that `choice` status first.
 */
async function chooseOption(
  issues: DeliveryWorld["issues"],
  status?: "chosen" | "applying" | "applied" | "dropped",
) {
  permissions(issues);
  await writeOptionsRecord(issues);
  decide(issues, 2);
  freshReads(issues.github.client);
  if (status !== undefined) {
    const live = await readLiveDecision(issues.github.client, issueRef);
    await saveChoice(issues.github.client, issueRef, live!, status);
    freshReads(issues.github.client);
  }
}

/** The review world with a chosen option (`status` as in `chooseOption`). */
function reviewWithChoice(
  status?: "chosen" | "applying" | "applied" | "dropped",
  change?: (world: Awaited<ReturnType<typeof reviewWorld>>) => void,
): Build {
  return async () => {
    const world = await reviewWorld();
    change?.(world);
    await chooseOption(world.issues, status);
    return world.issues.github.client;
  };
}

/**
 * The review world with an options record and a writer's comment in their own
 * words; with `afterRemoval`, `pending` was removed (no decision, R4.52) before it.
 */
function reviewWithWords(afterRemoval: boolean): Build {
  return async () => {
    const world = await reviewWorld();
    const { issues } = world;
    permissions(issues);
    await writeOptionsRecord(issues);
    if (afterRemoval) {
      unlabel(issues.main, "pending");
    }
    decide(issues, "Drop the widget, and keep `pause`.");
    freshReads(issues.github.client);
    return issues.github.client;
  };
}

function onFixBranch(world: DeliveryWorld) {
  failedCd(world);
  const { fixture } = world;
  git(fixture.other, "checkout", "--quiet", "-b", `${branch}-cd-1`);
  commitFile(fixture.other, "fix.txt", "fix\n", "fix: repair CD");
  git(fixture.other, "push", "--quiet", "origin", `${branch}-cd-1`);
}

const assignees = [{ id: 5, login: "taco" }];
const route = (stage: NextAction["stage"], reason: NextAction["reason"]) =>
  stage === null ? null : { stage, reason, assignees };

describe("routeIssue", () => {
  const table: Array<[string, Build, ReturnType<typeof route>]> = [
    ["shape", plain({ labels: ["scope"] }), route("shape", null)],
    ["a request", plain({ labels: ["request"] }), route("scope", null)],
    ["a shaped request", plain({ labels: ["request", "shaped"] }), route("scope", null)],
    ["a scoped request", plain({ labels: ["request", "scope"] }), route("shape", null)],
    ["a paused request", plain({ labels: ["request", "pause"] }), null],
    ["a pending request", plain({ labels: ["request", "pending"] }), null],
    ["deliver", () => delivery(), route("deliver", null)],
    ["a pending shape-wrong report", () => delivery(reportWrong), route("deliver", null)],
    [
      "a pending report at review",
      atReview((w) => reportWrong(w)),
      route("deliver", null),
    ],
    ["review without a comment", atReview(), route("review", null)],
    [
      "review with a current comment",
      atReview((w) => reviewComment(w, true)),
      route("deliver", "review"),
    ],
    [
      "review waiting for a writer's approval",
      atReview((w) => {
        approvalWait(w);
        addReview(w, { id: 1, login: "ann", state: "APPROVED", permission: "read" });
      }),
      null,
    ],
    [
      "review waiting for a writer whose older changes stand",
      atReview((w) => {
        approvalWait(w);
        addReview(w, { id: 1, login: "ann", state: "APPROVED" });
        addReview(w, {
          id: 2,
          login: "bob",
          state: "CHANGES_REQUESTED",
          commitId: "abc1234",
        });
      }),
      null,
    ],
    [
      "review whose wait has its approvals",
      atReview((w) => {
        approvalWait(w);
        addReview(w, { id: 1, login: "ann", state: "APPROVED" });
      }),
      route("finish", null),
    ],
    [
      "review whose wait has changes requested on the head",
      atReview((w) => {
        approvalWait(w);
        addReview(w, { id: 1, login: "ann", state: "CHANGES_REQUESTED" });
      }),
      route("finish", null),
    ],
    [
      "review with a stale wait",
      atReview((w) => approvalWait(w, "abcdef1")),
      route("review", null),
    ],
    [
      "review with a stale comment",
      atReview((w) => reviewComment(w, false)),
      route("review", null),
    ],
    [
      "ci-failed",
      atReview((w) => {
        w.required = ["test"];
        w.checkRuns.set(w.head, [failedActionsCheck(1, "test")]);
      }),
      route("deliver", "ci-failure"),
    ],
    ["awaiting-ci", atReview((w) => void (w.required = ["test"])), null],
    [
      "conflict",
      atReview((w) => void (w.mergeable = false)),
      route("deliver", "conflict"),
    ],
    ["cd-failed", () => delivery((w) => failedCd(w)), route("deliver", "cd-failure")],
    ["a CD fix branch", () => delivery(onFixBranch), route("deliver", "cd-failure")],
    ["done", atReview((w) => mergePull(w, w.pull)), route("finish", null)],
    [
      "awaiting-cd",
      atReview((w) =>
        Object.assign(w.pull, { state: "closed", merged: true, mergeSha: "m" }),
      ),
      null,
    ],
    ["review with a new chosen option", reviewWithChoice(), route("shape", null)],
    [
      "review with a stored chosen option",
      reviewWithChoice("chosen"),
      route("shape", null),
    ],
    [
      "review with an option left applying",
      reviewWithChoice("applying"),
      route("shape", null),
    ],
    ["review with an applied option", reviewWithChoice("applied"), route("review", null)],
    ["review with a decision in own words", reviewWithWords(false), route("shape", null)],
    [
      "review with chat after pending was removed without a decision",
      reviewWithWords(true),
      route("review", null),
    ],
    ["review with a dropped option", reviewWithChoice("dropped"), route("review", null)],
    [
      "a pending report with a chosen option",
      reviewWithChoice(undefined, (w) => reportWrong(w)),
      route("shape", null),
    ],
    [
      "ci-failed with an applied option",
      reviewWithChoice("applied", (w) => {
        w.required = ["test"];
        w.checkRuns.set(w.head, [failedActionsCheck(1, "test")]);
      }),
      route("deliver", "ci-failure"),
    ],
    [
      "deliver with a chosen option",
      () => delivery((w) => chooseOption(w.issues)),
      route("shape", null),
    ],
    [
      "a pending Issue with a chosen option",
      async () => {
        const issues = fakeIssues(fakeIssue({ labels: ["scope", "shaped", "pending"] }));
        await chooseOption(issues);
        return issues.github.client;
      },
      null,
    ],
    ["no scope", plain({ labels: [] }), null],
    ["paused", plain({ labels: ["scope", "pause"] }), null],
    ["pending", plain({ labels: ["scope", "shaped", "pending"] }), null],
    ["no assignee", plain({ assignees: [] }), null],
    ["closed and not delivered", plain({ state: "closed" }), null],
  ];
  for (const [name, build, expected] of table) {
    it(`routes ${name}`, async () => {
      assert.deepEqual(await routeIssue(await build(), repo, 1, log), expected);
    });
  }

  it("routes a request to scope again once its pending is removed", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["request", "pending"] }));
    const { client } = issues.github;
    assert.equal(await routeIssue(client, repo, 1, log), null);
    issues.main.labels = ["request"];
    freshReads(client);
    assert.deepEqual(await routeIssue(client, repo, 1, log), route("scope", null));
  });

  it("routes a shape Issue from one Issue-record query", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    const state = await readRoute(issues.github.client, repo, 1, log);
    assert.deepEqual(state.route, route("shape", null));
    assert.deepEqual(
      issues.github.calls.map((call) => `${call.method} ${call.path}`),
      ["POST /graphql"],
    );
  });

  it("reads the Issue record once while routing a review", async () => {
    const world = await reviewWorld();
    const { github } = world.issues;
    reviewComment(world, true);
    freshReads(github.client);
    const before = github.calls.length;
    const state = await readRoute(github.client, repo, 1, log);
    assert.deepEqual(state.route, route("deliver", "review"));
    const calls = github.calls.slice(before);
    const records = calls.filter((call) =>
      (call.body as { query?: string } | undefined)?.query?.includes("IssueRecord"),
    );
    assert.equal(records.length, 1);
    assert.ok(!calls.some((call) => call.path.startsWith("/repos/acme/app/issues/1")));
  });

  it("routes a closed Issue it delivered to the finish stage's wake", async () => {
    const issues = fakeIssues(
      fakeIssue({ state: "closed", labels: ["scope", "shaped", "delivered"] }),
    );
    seedComment(issues, issues.main, "<!-- nibfin:delivered -->\nDelivered.");
    const state = await readRoute(issues.github.client, repo, 1, log);
    assert.deepEqual(state.route, route("finish", null));
    assert.equal(state.open, false);
    issues.main.assignees = [];
    freshReads(issues.github.client);
    assert.equal(await routeIssue(issues.github.client, repo, 1, log), null);
  });

  it("routes a closed Issue delivered by hand to the finish stage's wake", async () => {
    const issues = fakeIssues(
      fakeIssue({ state: "closed", labels: ["scope", "delivered"] }),
    );
    assert.deepEqual(
      await routeIssue(issues.github.client, repo, 1, log),
      route("finish", null),
    );
  });

  it("does not route a closed Issue without delivered", async () => {
    const issues = fakeIssues(fakeIssue({ state: "closed", labels: ["scope"] }));
    assert.equal(await routeIssue(issues.github.client, repo, 1, log), null);
  });

  it("routes with every Assignee in GitHub's order", async () => {
    const assignees = [
      { id: 9, login: "first" },
      { id: 5, login: "second" },
    ];
    const state = await readRoute(await plain({ assignees })(), repo, 1, log);
    assert.deepEqual(state.route, { stage: "shape", reason: null, assignees });
    assert.deepEqual(state.stage, { stage: "shape" });
    assert.equal(state.repair, null);
  });

  it("gives the repair need of a pending Issue and no route (#777)", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    const error = new StageError("STAGE_GIT_FAILED", "x");
    await requestPerson(issues.github.client, { ...repo, number: 1 }, error, undefined);
    const state = await readRoute(issues.github.client, repo, 1, log);
    assert.equal(state.route, null);
    assert.equal(state.repair?.kind, "new");
    assert.equal(state.repair?.pending?.id, issues.marked("pending")[0].id);
  });

  it("does not repair a paused or closed pending Issue", async () => {
    for (const overrides of [
      { labels: ["scope", "pause", "pending"] },
      { state: "closed" as const, labels: ["scope", "pending"] },
    ]) {
      const state = await readRoute(await plain(overrides)(), repo, 1, log);
      assert.equal(state.repair, null);
    }
  });
});

/**
 * Every documented non-null next action of the stages, set up as the state the
 * stage leaves behind: the route on that state asks for the same run, except two
 * cases that end the same way (see the comments).
 */
describe("routeIssue and the stages' next actions", () => {
  const rows: Array<[string, Build, NextAction, NextAction]> = [
    ["Deliver opened the PR", atReview(), r("review", null), r("review", null)],
    [
      "Deliver reported the Shape wrong",
      () => delivery(reportedShaped),
      r("shape", null),
      r("shape", null),
    ],
    [
      "Deliver ended at review with a stale review",
      atReview((w) => reviewComment(w, false)),
      r("review", null),
      r("review", null),
    ],
    [
      "review found problems or asked for a rebase",
      atReview((w) => reviewComment(w, true)),
      r("deliver", "review"),
      r("deliver", "review"),
    ],
    [
      "review or Shape saw a pending report",
      atReview((w) => reportWrong(w)),
      r("deliver", null),
      r("deliver", null),
    ],
    [
      "review at cd-failed",
      () => delivery((w) => failedCd(w)),
      r("deliver", "cd-failure"),
      r("deliver", "cd-failure"),
    ],
    [
      "Shape rewrite at deliver",
      () => delivery(),
      r("deliver", null),
      r("deliver", null),
    ],
    [
      "Shape rewrite on a CD fix branch",
      () => delivery(onFixBranch),
      r("deliver", "cd-failure"),
      r("deliver", "cd-failure"),
    ],
    [
      "Shape rewrite at ci-failed",
      atReview((w) => {
        w.required = ["test"];
        w.checkRuns.set(w.head, [failedActionsCheck(1, "test")]);
      }),
      r("deliver", "ci-failure"),
      r("deliver", "ci-failure"),
    ],
    [
      "Shape rewrite at done",
      atReview((w) => mergePull(w, w.pull)),
      r("finish", null),
      r("finish", null),
    ],
    // A Deliver review fix without a new head writes review; the route asks for the
    // same fix again, which the no-progress check turns into pending.
    [
      "Deliver review fix without a new head",
      atReview((w) => reviewComment(w, true)),
      r("review", null),
      r("deliver", "review"),
    ],
    // A Shape rewrite with unchanged text and head keeps the review current: the
    // review stage would ask for the same fix without reviewing.
    [
      "Shape rewrite with unchanged text and head",
      atReview((w) => reviewComment(w, true)),
      r("review", null),
      r("deliver", "review"),
    ],
  ];
  for (const [name, build, written, routed] of rows) {
    it(`${name}: ${JSON.stringify(written)} → ${JSON.stringify(routed)}`, async () => {
      const result = await routeIssue(await build(), repo, 1, log);
      assert.deepEqual(result, route(routed.stage, routed.reason));
    });
  }
});

function r(stage: NextAction["stage"], reason: NextAction["reason"]): NextAction {
  return { stage, reason };
}

function reportedShaped(world: DeliveryWorld) {
  reportWrong(world);
  world.issues.main.labels = ["scope"];
}

describe("routeEvent", () => {
  const committed = "2026-11-26T19:34:27Z";

  /** A closed pull request of the listing, updated at `updated`. */
  function closed(
    number: number,
    head: string,
    mergeSha: string | null,
    updated: string,
  ) {
    const merged = mergeSha !== null;
    return { ...pullJson(number, { head, merged, mergeSha }), updated_at: updated };
  }

  function commitPulls(pulls: unknown[], closedPulls: unknown[] = []) {
    const issues = fakeIssues(fakeIssue());
    const { routes } = issues.github;
    routes.set("GET /repos/acme/app/commits/abc1234/pulls", paged(pulls));
    routes.set("GET /repos/acme/app/git/commits/abc1234", {
      data: { sha: "abc1234", committer: { date: committed } },
    });
    routes.set("GET /repos/acme/app/pulls", paged(closedPulls));
    return issues;
  }

  it("names the Issue of an Issue event", async () => {
    const client = fakeIssues(fakeIssue()).github.client;
    assert.deepEqual(await routeEvent(client, repo, { issue: 3 }), [3]);
  });

  it("maps delivery and CD fix branches, and nothing else", async () => {
    const client = fakeIssues(fakeIssue()).github.client;
    assert.deepEqual(await routeEvent(client, repo, { branch: "nibfin/issue-12" }), [12]);
    assert.deepEqual(
      await routeEvent(client, repo, { branch: "nibfin/issue-12-cd-2" }),
      [12],
    );
    for (const other of ["main", "nibfin/issue-0", "nibfin/issue-1-x", "feature"]) {
      assert.deepEqual(await routeEvent(client, repo, { branch: other }), []);
    }
  });

  it("maps a merge commit to its merged pull request's Issue", async () => {
    const pulls = [
      pullJson(3, { head: "feature", merged: true }),
      pullJson(4, { head: "nibfin/issue-8", merged: true }),
    ];
    const { client } = commitPulls(pulls).github;
    assert.deepEqual(await routeEvent(client, repo, { sha: "abc1234" }), [8]);
  });

  it("maps an open pull request's head commit", async () => {
    const pulls = [pullJson(4, { head: "nibfin/issue-8-cd-1" })];
    const { client } = commitPulls(pulls).github;
    assert.deepEqual(await routeEvent(client, repo, { sha: "abc1234" }), [8]);
  });

  it("maps an unrelated commit to nothing", async () => {
    const pulls = [
      pullJson(3, { head: "feature" }),
      pullJson(4, { head: "nibfin/issue-8", state: "closed" }),
    ];
    const { client } = commitPulls(pulls).github;
    assert.deepEqual(await routeEvent(client, repo, { sha: "abc1234" }), []);
  });

  it("adds every Nibfin pull request merged to the commit, once each", async () => {
    // gh-nibfin #450 and #452: the second merged to the same commit without moving
    // main, and GitHub associates only the first with it.
    const associated = [pullJson(450, { head: "nibfin/issue-363", merged: true })];
    const listed = [
      closed(452, "nibfin/issue-412-cd-1", "abc1234", "2026-11-26T19:35:56Z"),
      closed(451, "feature", "abc1234", "2026-11-26T19:35:00Z"),
      closed(450, "nibfin/issue-363", "abc1234", "2026-11-26T19:34:28Z"),
      closed(449, "nibfin/issue-9", "other00", "2026-11-26T19:34:27Z"),
      closed(448, "nibfin/issue-10", null, "2026-11-26T19:30:00Z"),
    ];
    const issues = commitPulls(associated, listed);
    const result = await routeEvent(issues.github.client, repo, { sha: "abc1234" });
    assert.deepEqual(result, [363, 412]);
    const list = issues.github.calls.find(
      (call) => call.path === "/repos/acme/app/pulls",
    );
    assert.deepEqual(Object.fromEntries(list!.query), {
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
  });

  it("stops listing after the page that reaches the commit's date", async () => {
    const recent = (number: number) =>
      closed(number, "nibfin/issue-5", "abc1234", "2026-11-27T00:00:00Z");
    const listed = [
      ...Array.from({ length: 99 }, (_, k) => recent(400 - k)),
      closed(301, "nibfin/issue-6", "abc1234", "2026-11-25T00:00:00Z"),
      closed(300, "nibfin/issue-7", "abc1234", "2026-11-27T00:00:00Z"),
    ];
    const issues = commitPulls([], listed);
    const result = await routeEvent(issues.github.client, repo, { sha: "abc1234" });
    assert.deepEqual(result, [5, 6]);
    const pages = issues.github.calls.filter(
      (call) => call.path === "/repos/acme/app/pulls",
    );
    assert.equal(pages.length, 1);
  });

  it("reads every page while no pull request predates the commit", async () => {
    const listed = Array.from({ length: 101 }, (_, k) =>
      closed(500 - k, `nibfin/issue-${k + 1}`, k === 100 ? "abc1234" : null, committed),
    );
    const issues = commitPulls([], listed);
    const result = await routeEvent(issues.github.client, repo, { sha: "abc1234" });
    assert.deepEqual(result, [101]);
  });

  for (const path of [
    "/repos/acme/app/commits/abc1234/pulls",
    "/repos/acme/app/git/commits/abc1234",
    "/repos/acme/app/pulls",
  ]) {
    it(`fails as a read when GitHub fails GET ${path}`, async () => {
      const issues = commitPulls([]);
      issues.github.routes.set(`GET ${path}`, failure(500));
      const error = await rejection(
        routeEvent(issues.github.client, repo, { sha: "abc1234" }),
      );
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    });
  }
});

describe("a commit two Nibfin pull requests merged to (#771)", () => {
  // gh-nibfin #450 (Issue #363) merged as the commit; #452 (Issue #412) merged to the
  // same commit without moving main, and GitHub associates only #450 with it. Each
  // world holds one of the two Issues as acme/app#1, the other as acme/app#2.
  for (const associated of [true, false]) {
    const which = associated ? "associates with" : "does not associate with";
    it(`finishes the Issue whose pull request GitHub ${which} it`, async () => {
      const world = await reviewWorld();
      mergePull(world, world.pull);
      const sha = world.pull.mergeSha!;
      world.pulls.push({
        number: 6,
        state: "closed",
        merged: true,
        head: "nibfin/issue-2",
        sha: "c".repeat(40),
        mergeSha: sha,
      });
      const first = associated ? world.pull : world.pulls.at(-1)!;
      const json = pullJson(first.number, { head: first.head, merged: true });
      world.commitPulls.set(sha, [json]);
      const { client } = world.issues.github;
      const issues = await routeEvent(client, repo, { sha });
      assert.deepEqual(issues, associated ? [1, 2] : [2, 1]);
      assert.deepEqual(await routeIssue(client, repo, 1, log), route("finish", null));
      assert.equal(await world.finish(), 0);
      assert.equal(world.issues.main.state, "closed");
      assert.ok(world.issues.main.labels.includes("delivered"));
      assert.equal(world.issues.marked("delivered").length, 1);
    });
  }
});
