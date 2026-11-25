import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import { NoProgressError, type NextActionRecord } from "../stages/index.ts";
import { deliveryWorld } from "../stages/fake-delivery.test.ts";
import {
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  seedComment,
  shapeVersion,
} from "../stages/fake-job.test.ts";
import { addPullComment, reviewWorld } from "../stages/fake-review.test.ts";
import { continueAfterStage, type FinishedStage } from "./after-stage.ts";
import { fakeRunner } from "./fake-runner.test.ts";

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

  it("writes nothing for several Assignees; the assigned route does", async () => {
    const assignees = [
      { id: 5, login: "taco" },
      { id: 6, login: "other" },
    ];
    const { issues, runner } = plainRunner({ labels: ["scope", "shaped"], assignees });
    await continueAfterStage(runner.scope, finished("deliver"), record(true));
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(issues.github.writes(), []);
    assert.deepEqual(runner.logs, ["acme/app#1: nothing to run now"]);
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
