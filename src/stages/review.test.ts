import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fakeToken, rejection } from "../github/fake-github.test.ts";
import { checkRun } from "../github/fixtures.test.ts";
import { StageError } from "./errors.ts";
import { branch } from "./fake-delivery.test.ts";
import { commitFile, fixtureGit, git } from "./fake-git.test.ts";
import { addPullComment, type ReviewWorld, reviewWorld } from "./fake-review.test.ts";
import { agentResult, type AgentStep } from "./fake-job.test.ts";
import { checkoutReviewedHead } from "./git.ts";

const basic = Buffer.from(`x-access-token:${fakeToken}`).toString("base64");

function verdict(world: () => ReviewWorld, value: Record<string, unknown>) {
  return (): string => agentResult({ reviewedHead: world().head, ...value });
}

/** A review world whose scripted agent runs can read the world once it exists. */
async function world(steps: (w: () => ReviewWorld) => AgentStep[], noShape = false) {
  const holder: { world?: ReviewWorld } = {};
  const get = () => holder.world!;
  holder.world = await reviewWorld({ steps: steps(get), noShape });
  return holder.world;
}

function prCommentBodies(w: ReviewWorld): string[] {
  return (w.pullComments.get(7) ?? []).map((comment) => comment.body);
}

/** No token in a Git argument, agent run or log; Core's repository is removed. */
function assertNoTokenLeak(w: ReviewWorld) {
  for (const call of w.git.calls) {
    const args = call.args.join(" ");
    assert.ok(!args.includes(fakeToken) && !args.includes(basic), args);
    if (call.env.GIT_CONFIG_COUNT !== undefined) {
      assert.notEqual(call.cwd, w.fixture.workspace);
    }
  }
  for (const run of w.agent.runs) {
    const text = JSON.stringify(run);
    assert.ok(!text.includes(fakeToken) && !text.includes(basic));
  }
  for (const line of w.agent.logs) {
    assert.ok(!line.includes(fakeToken));
  }
  const left = readdirSync(w.fixture.root).filter((name) =>
    name.startsWith("nibfin-review-"),
  );
  assert.deepEqual(left, []);
}

describe("runReviewStage review", () => {
  it("reviews the pinned head read-only and sends problems back", async () => {
    const w = await world((get) => [
      (options) => {
        const head = git(get().fixture.workspace, "rev-parse", "HEAD");
        assert.equal(head, get().head);
        assert.match(options.prompt, /Your role is PR review\./);
        assert.match(options.prompt, /widget\.txt/);
        assert.match(options.prompt, new RegExp(`pinned head ${get().head}`));
        assert.match(options.prompt, /requires no checks/);
        assert.match(options.prompt, /## Approved Shape\n\n## Plan/);
        assert.match(options.prompt, /git show refs\/remotes\/origin\/main:<path>/);
        return verdict(get, { outcome: "problems", problems: ["Fix A", "Fix B"] })();
      },
    ]);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: "review" });
    assert.deepEqual(prCommentBodies(w), [
      `<!-- nibfin:review -->\nReviewed head: ${w.head}\n\n` +
        "Problems found in the review:\n\n- Fix A\n- Fix B",
    ]);
    assert.equal(w.agent.runs.length, 1);
    assert.deepEqual(w.agent.skillReads, ["shape"]);
    assert.equal(git(w.fixture.workspace, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assertNoTokenLeak(w);
  });

  it("reuses a review comment that already records the head", async () => {
    const w = await world(() => []);
    addPullComment(w, 7, `<!-- nibfin:review -->\nReviewed head: ${w.head}\n\nX`);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: "review" });
    assert.deepEqual(w.agent.runs, []);
    assert.deepEqual(w.git.calls, []);
    assert.deepEqual(w.issues.github.writes(), []);
  });

  it("reviews again when the comment records an older head", async () => {
    const w = await world((get) => [verdict(get, { outcome: "clean" })]);
    addPullComment(w, 7, "<!-- nibfin:review -->\nReviewed head: abcdef1\n\nX");
    addPullComment(w, 7, `<!-- nibfin:review -->\nReviewed head: ${w.head}`, 99);
    assert.equal(await w.review(), 0);
    assert.equal(w.agent.runs.length, 1);
    assert.equal(w.mergeRequests.length, 1);
  });

  it("rejects a result for another head without writing", async () => {
    const w = await world(() => [
      () => agentResult({ outcome: "clean", reviewedHead: "0".repeat(40) }),
    ]);
    const error = await rejection(w.review());
    assert.equal((error as StageError).code, "STAGE_RESULT_INVALID");
    assert.deepEqual(w.next(), { stage: null, reason: null });
    assert.deepEqual(w.issues.github.writes(), []);
    assertNoTokenLeak(w);
  });

  it("stops without writing when the head moved during the review", async () => {
    const w = await world((get) => [
      () => {
        const { fixture, pull } = get();
        pull.sha = commitFile(fixture.other, "more.txt", "more\n", "feat: more");
        git(fixture.other, "push", "--quiet", "origin", branch);
        return verdict(get, { outcome: "problems", problems: ["X"] })();
      },
    ]);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: null, reason: null });
    assert.deepEqual(w.issues.github.writes(), []);
    assert.match(w.agent.logs.at(-1)!, /moved on during the review/);
  });

  it("reports a blocked review on the Issue", async () => {
    const w = await world((get) => [
      verdict(get, { outcome: "blocked", reason: "The authority is missing." }),
    ]);
    const error = await rejection(w.review());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.deepEqual(w.next(), { stage: null, reason: null });
    assert.deepEqual(
      w.issues.marked("review-blocked").map((comment) => comment.body),
      [
        "<!-- nibfin:review-blocked -->\nThe review is blocked (PR review).\n\n" +
          "The authority is missing.",
      ],
    );
    assert.deepEqual(prCommentBodies(w), []);
  });

  it("merges a clean pull request at the reviewed head", async () => {
    const w = await world((get) => [verdict(get, { outcome: "clean" })]);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: null, reason: null });
    assert.deepEqual(
      w.mergeRequests.map((request) => request.body),
      [{ sha: w.head, merge_method: "rebase" }],
    );
    assert.ok(w.agent.logs.some((line) => line.startsWith("Merged ")));
    assert.deepEqual(prCommentBodies(w), []);
    assertNoTokenLeak(w);
  });

  it("blocks when the Issue has no approved Shape", async () => {
    const w = await world(() => [], true);
    const error = await rejection(w.review());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.match(w.issues.marked("review-blocked")[0].body, /no approved Shape/);
    assert.deepEqual(w.agent.runs, []);
  });

  it("gives the reviewer the required checks of the pinned head", async () => {
    const w = await world((get) => [
      (options) => {
        const { prompt } = options;
        assert.ok(prompt.includes("Title: Add the widget\n\n(no description)"));
        assert.match(prompt, /Required checks of `main` on [0-9a-f]{40}:/);
        assert.ok(
          prompt.includes("- build: success (https://github.com/acme/app/runs/1)"),
        );
        assert.ok(prompt.includes("- lint: success (no URL)"));
        return verdict(get, { outcome: "problems", problems: ["X"] })();
      },
    ]);
    w.issues.main.body = null;
    w.required.push("build", "lint");
    w.checkRuns.set(w.head, [checkRun(1, "build")]);
    w.issues.github.routes.set(`GET /repos/acme/app/commits/${w.head}/statuses`, {
      data: [{ id: 1, context: "lint", state: "success", target_url: null }],
    });
    assert.equal(await w.review(), 0);
    assert.equal(w.agent.runs.length, 1);
  });
});

describe("checkoutReviewedHead", () => {
  it("accepts only a full commit SHA", async () => {
    const w = await reviewWorld();
    const error = await rejection(
      checkoutReviewedHead(fixtureGit(w.fixture), { base: "main", head: "abc1234" }),
    );
    assert.equal((error as StageError).code, "STAGE_INPUT_INVALID");
  });
});
