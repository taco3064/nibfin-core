import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failure,
  fakeGitHub,
  networkError,
  rejection,
} from "../github/fake-github.test.ts";
import { GitHubError, notStartedStatuses } from "../github/index.ts";
import { dispatchRoute, dispatchStage, sharedRunnerWorkflow } from "./dispatch.ts";
import { dispatchPath, fakeRunner } from "./fake-runner.test.ts";

const repo = { owner: "acme", repo: "app" };
const deliver = { stage: "deliver" as const, reason: "ci-failure" as const, assignee: 5 };
const title = "Nibfin · acme/app#1 · deliver";

describe("dispatchStage", () => {
  it("dispatches the stage on the default branch with its inputs", async () => {
    const runner = fakeRunner(fakeGitHub());
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    assert.equal(sharedRunnerWorkflow, "nibfin-shared-runner.yml");
    assert.deepEqual(runner.requests[0].body, {
      ref: "main",
      inputs: {
        stage: "deliver",
        repo: "acme/app",
        issue: "1",
        reason: "ci-failure",
        assignee: "5",
      },
      return_run_details: true,
    });
    assert.deepEqual(runner.logs, [
      `Dispatched ${title}: https://github.com/acme/runner/actions/runs/1001`,
    ]);
  });

  it("sends an empty reason for a stage without one", async () => {
    const runner = fakeRunner(fakeGitHub());
    await dispatchStage(runner.scope, repo, 1, { ...deliver, reason: null });
    assert.equal(runner.dispatched[0].reason, "");
  });

  for (const status of notStartedStatuses) {
    it(`skips while a ${status} run has the same title`, async () => {
      const runner = fakeRunner(fakeGitHub());
      runner.runs.push({ id: 7, status, display_title: title });
      assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), false);
      assert.deepEqual(runner.dispatched, []);
      assert.deepEqual(runner.logs, [
        `Not dispatching ${title}: run 7 is waiting to start`,
      ]);
    });
  }

  it("dispatches past a running run, its own run and other titles", async () => {
    const runner = fakeRunner(fakeGitHub(), 900);
    runner.runs.push(
      { id: 7, status: "in_progress", display_title: title },
      { id: 900, status: "queued", display_title: title },
      { id: 8, status: "queued", display_title: "Nibfin · acme/app#1 · review" },
      { id: 9, status: "queued", display_title: "Nibfin · acme/app#2 · deliver" },
    );
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    assert.equal(runner.dispatched.length, 1);
  });

  it("logs no URL when GitHub returns none", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    github.routes.set(`POST ${dispatchPath}`, { status: 204 });
    await dispatchStage(runner.scope, repo, 1, deliver);
    assert.deepEqual(runner.logs, [`Dispatched ${title}`]);
  });

  for (const [name, answer, code] of [
    ["a 5xx", failure(502), "GITHUB_WRITE_UNCONFIRMED"],
    ["no response", networkError(), "GITHUB_WRITE_UNCONFIRMED"],
    ["a 422", failure(422, "Unexpected inputs"), "GITHUB_WRITE_REJECTED"],
  ] as const) {
    it(`fails the dispatch on ${name}`, async () => {
      const github = fakeGitHub();
      const runner = fakeRunner(github);
      github.routes.set(`POST ${dispatchPath}`, answer);
      const error = await rejection(dispatchStage(runner.scope, repo, 1, deliver));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, code);
    });
  }

  it("fails as a read when the runs cannot be listed", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    github.routes.set("GET /repos/acme/runner/actions/runs", failure(500));
    const error = await rejection(dispatchStage(runner.scope, repo, 1, deliver));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.deepEqual(runner.dispatched, []);
  });
});

describe("dispatchRoute", () => {
  it("dispatches a route run without looking for duplicates", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    const route = "Nibfin · acme/app#1 · route";
    runner.runs.push({ id: 7, status: "queued", display_title: route });
    await dispatchRoute(runner.scope, repo, 1);
    assert.deepEqual(runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
    assert.ok(!github.calls.some((call) => call.path.endsWith("/actions/runs")));
  });
});
