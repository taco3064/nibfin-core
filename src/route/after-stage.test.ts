import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import { NoProgressError, type NextActionRecord } from "../stages/index.ts";
import { deliveryWorld } from "../stages/fake-delivery.test.ts";
import {
  agentResult,
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  seedComment,
  shapeVersion,
} from "../stages/fake-job.test.ts";
import {
  addPullComment,
  requireApprovals,
  reviewWorld,
} from "../stages/fake-review.test.ts";
import { continueAfterStage, type FinishedStage } from "./after-stage.ts";
import { fakeRunner, selfHostedRunner } from "./fake-runner.test.ts";

const repo = { owner: "acme", repo: "app" };

function finished(
  stage: FinishedStage["stage"],
  reason: FinishedStage["reason"] = null,
): FinishedStage {
  return { repo, issue: 1, stage, reason };
}

function record(progressed: boolean, extra: Partial<NextActionRecord> = {}) {
  return { stage: null, reason: null, progressed, ...extra };
}

function plainRunner(overrides: Partial<FakeIssue>) {
  const issues = fakeIssues(fakeIssue(overrides));
  return { issues, runner: fakeRunner(issues.github) };
}

describe("continueAfterStage", () => {
  it("wakes downstream Issues first, then dispatches the route result", async () => {
    const world = await deliveryWorld();
    const runner = fakeRunner(world.issues.github);
    const wake = [
      { repo: "acme/lib", issue: 3 },
      { repo: "acme/app", issue: 4 },
    ];
    await continueAfterStage(runner.scope, finished("review"), record(true, { wake }));
    assert.deepEqual(runner.dispatched, [
      { stage: "route", repo: "acme/lib", issue: "3" },
      { stage: "route", repo: "acme/app", issue: "4" },
      { stage: "deliver", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
  });

  it("dispatches a closed Issue's wakes only, never its own route", async () => {
    const { issues, runner } = plainRunner({
      state: "closed",
      labels: ["scope", "shaped", "delivered"],
    });
    seedComment(issues, issues.main, "<!-- nibfin:delivered -->\nDelivered.");
    const wake = [{ repo: "acme/lib", issue: 3 }];
    // A wake-only redo writes nothing: the no-progress check never applies here.
    await continueAfterStage(runner.scope, finished("review"), record(false, { wake }));
    assert.deepEqual(runner.dispatched, [
      { stage: "route", repo: "acme/lib", issue: "3" },
    ]);
    assert.deepEqual(runner.logs.at(-1), "acme/app#1 is closed; nothing more to route");
  });

  it("dispatches nothing when nothing should run", async () => {
    const { runner } = plainRunner({ labels: ["scope", "shaped", "pending"] });
    await continueAfterStage(runner.scope, finished("shape"), record(true));
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(runner.logs, ["acme/app#1: nothing to run now"]);
  });

  it("dispatches nothing when no runner has the Assignee's label", async () => {
    const { issues, runner } = plainRunner({ labels: ["scope"] });
    runner.runners = [];
    await continueAfterStage(runner.scope, finished("deliver"), record(true));
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(issues.github.writes(), []);
    assert.match(runner.logs.at(-1)!, /an ordinary assignment, nothing dispatched$/);
  });

  it("dispatches several Assignees' route to the one with an online runner", async () => {
    const assignees = [
      { id: 6, login: "other" },
      { id: 5, login: "taco" },
    ];
    const { issues, runner } = plainRunner({ labels: ["scope", "shaped"], assignees });
    seedComment(issues, issues.main, "<!-- nibfin:consent-6 -->\nAsked.");
    runner.runners = [
      selfHostedRunner(1, ["nibfin-6"], { status: "offline" }),
      selfHostedRunner(2, ["nibfin-5"], { busy: true }),
    ];
    await continueAfterStage(runner.scope, finished("deliver"), record(true));
    assert.deepEqual(runner.dispatched, [
      { stage: "deliver", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    assert.ok(!issues.main.labels.includes("pending"));
    assert.ok(runner.logs.includes("acme/app#1: Assignee 5 has an online runner"));
  });

  it("asks a collaborator assigned during the run after the stage", async () => {
    const world = await deliveryWorld();
    const runner = fakeRunner(world.issues.github);
    world.issues.main.assignees = [{ id: 7, login: "ann" }];
    runner.runners = [selfHostedRunner(1, ["nibfin-7"])];
    await continueAfterStage(runner.scope, finished("review"), record(true));
    assert.deepEqual(runner.dispatched, []);
    assert.ok(world.issues.main.labels.includes("pause"));
    assert.equal(world.issues.marked("consent-7").length, 1);
    assert.match(runner.logs.at(-1)!, /consent of Assignee\(s\) 7; nothing dispatched$/);
  });

  it("dispatches the same stage again after progress", async () => {
    const { runner } = plainRunner({ labels: ["scope"] });
    await continueAfterStage(runner.scope, finished("shape"), record(true));
    assert.equal(runner.dispatched[0].stage, "shape");
  });

  it("dispatches another stage after no progress", async () => {
    const { runner } = plainRunner({ labels: ["scope"] });
    await continueAfterStage(runner.scope, finished("deliver"), record(false));
    assert.equal(runner.dispatched[0].stage, "shape");
  });

  it("stops a Deliver review fix without a new head with no progress", async () => {
    const world = await reviewWorld();
    const body =
      `<!-- nibfin:review -->\nReviewed head: ${world.head}\n` +
      `Reviewed Shape: ${shapeVersion(world.issues)}\n\nFix it.`;
    addPullComment(world, 7, body);
    const runner = fakeRunner(world.issues.github);
    const error = await rejection(
      continueAfterStage(runner.scope, finished("deliver", "review"), record(false)),
    );
    assert.ok(error instanceof NoProgressError);
    assert.equal(error.code, "STAGE_NO_PROGRESS");
    assert.equal(error.temporary, false);
    assert.deepEqual(runner.dispatched, []);
  });

  for (const progressed of [true, false]) {
    it(`dispatches nothing after a waiting review (${progressed})`, async () => {
      const world = await reviewWorld({
        steps: [() => agentResult({ outcome: "clean", reviewedHead: world.head })],
      });
      requireApprovals(world, 1);
      assert.equal(await world.review(), 0);
      // A rerun (a wake) finds the wait current and changes nothing.
      if (!progressed) {
        assert.equal(await world.review(), 0);
      }
      const next = world.next() as NextActionRecord;
      assert.deepEqual(next, record(progressed));
      const runner = fakeRunner(world.issues.github);
      await continueAfterStage(runner.scope, finished("review"), next);
      assert.deepEqual(runner.dispatched, []);
      assert.deepEqual(runner.logs, ["acme/app#1: nothing to run now"]);
    });
  }

  it("stops a conflict fix without progress, marked temporary", async () => {
    const world = await reviewWorld();
    world.pull.mergeable = false;
    world.mergeable = false;
    const runner = fakeRunner(world.issues.github);
    const error = await rejection(
      continueAfterStage(runner.scope, finished("deliver", "conflict"), record(false)),
    );
    assert.ok(error instanceof NoProgressError);
    assert.equal(error.temporary, true);
    assert.match(error.message, /deliver \(conflict\).*computing mergeability/);
    assert.deepEqual(runner.dispatched, []);
  });

  it("stops a review that could not merge yet, marked temporary", async () => {
    const world = await reviewWorld();
    const runner = fakeRunner(world.issues.github);
    const error = await rejection(
      continueAfterStage(runner.scope, finished("review"), record(false)),
    );
    assert.ok(error instanceof NoProgressError);
    assert.equal(error.temporary, true);
    assert.match(error.message, /computing mergeability/);
  });
});
