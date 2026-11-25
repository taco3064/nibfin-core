import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, paged, rejection } from "../github/fake-github.test.ts";
import { pull as pullJson } from "../github/fixtures.test.ts";
import { type ActingClient, freshReads, GitHubError } from "../github/index.ts";
import type { NextAction } from "../stages/index.ts";
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
} from "../stages/fake-job.test.ts";
import { addPullComment, mergePull, reviewWorld } from "../stages/fake-review.test.ts";
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

function onFixBranch(world: DeliveryWorld) {
  failedCd(world);
  const { fixture } = world;
  git(fixture.other, "checkout", "--quiet", "-b", `${branch}-cd-1`);
  commitFile(fixture.other, "fix.txt", "fix\n", "fix: repair CD");
  git(fixture.other, "push", "--quiet", "origin", `${branch}-cd-1`);
}

const assignee = 5;
const route = (stage: NextAction["stage"], reason: NextAction["reason"]) =>
  stage === null ? null : { stage, reason, assignee };

describe("routeIssue", () => {
  const table: Array<[string, Build, ReturnType<typeof route>]> = [
    ["shape", plain({ labels: ["scope"] }), route("shape", null)],
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
    ["done", atReview((w) => mergePull(w, w.pull)), route("review", null)],
    [
      "awaiting-cd",
      atReview((w) =>
        Object.assign(w.pull, { state: "closed", merged: true, mergeSha: "m" }),
      ),
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

  it("routes a closed Issue it delivered to the review stage's wake", async () => {
    const issues = fakeIssues(
      fakeIssue({ state: "closed", labels: ["scope", "shaped", "delivered"] }),
    );
    seedComment(issues, issues.main, "<!-- nibfin:delivered -->\nDelivered.");
    const state = await readRoute(issues.github.client, repo, 1, log);
    assert.deepEqual(state.route, route("review", null));
    assert.equal(state.open, false);
    issues.main.assignees = [];
    freshReads(issues.github.client);
    assert.equal(await routeIssue(issues.github.client, repo, 1, log), null);
  });

  it("does not route a closed delivered Issue without the actor's comment", async () => {
    const issues = fakeIssues(
      fakeIssue({ state: "closed", labels: ["scope", "delivered"] }),
    );
    seedComment(issues, issues.main, "<!-- nibfin:delivered -->\nForged.", 77);
    assert.equal(await routeIssue(issues.github.client, repo, 1, log), null);
  });

  it("routes to the only Assignee", async () => {
    const assignees = [{ id: 9, login: "only" }];
    const state = await readRoute(await plain({ assignees })(), repo, 1, log);
    assert.equal(state.route?.assignee, 9);
    assert.equal(state.assignees, 1);
  });

  it("routes nothing for several Assignees, with their count", async () => {
    const assignees = [
      { id: 9, login: "first" },
      { id: 5, login: "second" },
    ];
    const state = await readRoute(await plain({ assignees })(), repo, 1, log);
    assert.equal(state.route, null);
    assert.equal(state.assignees, 2);
    assert.deepEqual(state.stage, { stage: "ineligible", reason: "multiple-assignees" });
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
      r("review", null),
      r("review", null),
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
  function commitPulls(pulls: unknown[]) {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("GET /repos/acme/app/commits/abc1234/pulls", paged(pulls));
    return issues.github.client;
  }

  it("names the Issue of an Issue event", async () => {
    const client = fakeIssues(fakeIssue()).github.client;
    assert.equal(await routeEvent(client, repo, { issue: 3 }), 3);
  });

  it("maps delivery and CD fix branches, and nothing else", async () => {
    const client = fakeIssues(fakeIssue()).github.client;
    assert.equal(await routeEvent(client, repo, { branch: "nibfin/issue-12" }), 12);
    assert.equal(await routeEvent(client, repo, { branch: "nibfin/issue-12-cd-2" }), 12);
    for (const other of ["main", "nibfin/issue-0", "nibfin/issue-1-x", "feature"]) {
      assert.equal(await routeEvent(client, repo, { branch: other }), undefined);
    }
  });

  it("maps a merge commit to its merged pull request's Issue", async () => {
    const pulls = [
      pullJson(3, { head: "feature", merged: true }),
      pullJson(4, { head: "nibfin/issue-8", merged: true }),
    ];
    assert.equal(await routeEvent(commitPulls(pulls), repo, { sha: "abc1234" }), 8);
  });

  it("maps an open pull request's head commit", async () => {
    const pulls = [pullJson(4, { head: "nibfin/issue-8-cd-1" })];
    assert.equal(await routeEvent(commitPulls(pulls), repo, { sha: "abc1234" }), 8);
  });

  it("maps an unrelated commit to nothing", async () => {
    const pulls = [
      pullJson(3, { head: "feature" }),
      pullJson(4, { head: "nibfin/issue-8", state: "closed" }),
    ];
    assert.equal(
      await routeEvent(commitPulls(pulls), repo, { sha: "abc1234" }),
      undefined,
    );
  });

  it("fails as a read when GitHub fails", async () => {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("GET /repos/acme/app/commits/abc1234/pulls", failure(500));
    const error = await rejection(
      routeEvent(issues.github.client, repo, { sha: "abc1234" }),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});
