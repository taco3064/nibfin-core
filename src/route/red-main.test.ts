// #772: on a red `main`, only the Issue whose merge made it red starts a CD fix; the
// others wait and are woken by events. acme/app#1 is the review world's Issue B
// (its pull request #7); acme/app#2 is Issue A, which merged first.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEligibility } from "../stages/deliver-eligibility.ts";
import { redMain, routeRun, sha } from "./fake-red-main.test.ts";

const aBranch = "nibfin/issue-2";
const aFix = "nibfin/issue-2-cd-1";
const bBranch = "nibfin/issue-1";
const bFix = "nibfin/issue-1-cd-1";

/** A's merge M1 breaks CI on a green `main`, then B's merge M2 lands red on top. */
async function twoRedMerges(m2: Record<string, string | null> = { CI: "failure" }) {
  const red = await redMain();
  red.addIssue(2);
  red.merge(5, aBranch, sha.m1, { CI: "failure" });
  red.merge(7, bBranch, sha.m2, m2);
  return red;
}

const stageOf = (stage: { stage: string; reason?: unknown; waitingOn?: unknown }) => [
  stage.stage,
  stage.reason ?? null,
  stage.waitingOn ?? null,
];

describe("two merges in a row on a red main (#772)", () => {
  it("only the first starts a CD fix; the second finishes on its green fix", async () => {
    const red = await twoRedMerges();
    const a = await red.route(2);
    assert.equal(a.stage.stage, "cd-failed");
    assert.deepEqual(a.route && [a.route.stage, a.route.reason], [
      "deliver",
      "cd-failure",
    ]);
    const b = await red.route(1);
    assert.deepEqual(stageOf(b.stage), ["awaiting-cd", "previous-cd-red", 2]);
    assert.equal(b.route, null);
    // The finish stage of B only logs the wait: no fix, no pending, no comment.
    assert.equal(await red.world.finish(), 0);
    assert.deepEqual(red.world.next(), { stage: null, reason: null, progressed: false });
    assert.match(
      red.world.agent.logs.at(-1)!,
      /^acme\/app#1 is waiting for CD \(previous-cd-red, waiting on #2\)$/,
    );
    assert.ok(!red.world.issues.main.labels.includes("pending"));

    // A's fix F merges; its CD runs, then completes green.
    red.merge(6, aFix, sha.f, { CI: null });
    const early = await red.cli("--sha", sha.f);
    assert.deepEqual(early.dispatched, [routeRun(2)]);
    assert.match(early.out, /CD is not complete on main; no waiting Issue is woken/);
    assert.deepEqual(stageOf(await red.stage(1)), [
      "awaiting-cd",
      "previous-fix-cd-pending",
      2,
    ]);
    red.complete(sha.f, { CI: "success" });
    const woken = await red.cli("--sha", sha.f);
    assert.equal(woken.code, 0);
    assert.deepEqual(woken.dispatched, [routeRun(2), routeRun(1)]);
    const done = await red.route(1);
    assert.equal(done.stage.stage, "done");
    assert.deepEqual(done.route && [done.route.stage, done.route.reason], [
      "finish",
      null,
    ]);
    assert.equal((await red.route(2)).stage.stage, "done");

    assert.equal(await red.world.finish(), 0);
    assert.equal(red.world.issues.main.state, "closed");
    assert.ok(red.world.issues.main.labels.includes("delivered"));
    const [comment] = red.world.issues.marked("delivered");
    assert.match(
      comment.body,
      /- #7 merge `aaaa002`: CI \(`.github\/workflows\/ci.yml`\): failure/,
    );
    assert.match(
      comment.body,
      new RegExp(
        "- CD passed on newer `main` `ffff001`:\n" +
          "  - CI \\(`.github/workflows/ci.yml`\\): success \\(https://github.com/",
      ),
    );
  });

  it("the second starts its own fix when the first fix is red", async () => {
    const red = await twoRedMerges();
    red.merge(6, aFix, sha.f, { CI: "failure" });
    assert.deepEqual(stageOf(await red.stage(2)), ["awaiting-cd", "previous-cd-red", 1]);
    const woken = await red.cli("--sha", sha.f);
    assert.deepEqual(woken.dispatched, [routeRun(2), routeRun(1)]);
    const b = await red.route(1);
    assert.equal(b.stage.stage, "cd-failed");
    assert.deepEqual(b.route && [b.route.stage, b.route.reason], [
      "deliver",
      "cd-failure",
    ]);

    // B's Deliver points at F's failed runs, not at its own merge.
    const context = { ...red.world.context, reason: "cd-failure" as const };
    const eligibility = await readEligibility(
      red.world.issues.github.client,
      context,
      () => Promise.resolve(),
    );
    assert.ok(eligibility.eligible);
    assert.equal(eligibility.branch, bFix);
    const fix = eligibility.fix;
    assert.ok(fix?.reason === "cd-failure");
    assert.deepEqual(fix.failedOn, {
      mergeCommitSha: sha.f,
      pullRequestUrl: "https://github.com/acme/app/pull/6",
    });
    assert.deepEqual(
      fix.failed.map((run) => [run.name, run.conclusion]),
      [["CI", "failure"]],
    );

    // B's fix G is green: B finishes on its own merge, and A is woken and finishes.
    red.merge(8, bFix, sha.g, { CI: "success" });
    assert.equal((await red.stage(1)).stage, "done");
    const after = await red.cli("--sha", sha.g);
    assert.deepEqual(after.dispatched, [routeRun(1), routeRun(2)]);
    const a = await red.route(2);
    assert.equal(a.stage.stage, "done");
    assert.ok(a.stage.stage === "done");
    assert.equal(a.stage.passedOn?.mergeCommitSha, sha.g);
    assert.deepEqual(a.route && a.route.stage, "finish");
  });

  for (const m3 of [null, "failure"]) {
    it(`the fixer closes as delivered under a ${m3 ?? "pending"} head`, async () => {
      const red = await twoRedMerges();
      red.merge(6, aFix, sha.f, { CI: "success" });
      const c = red.addIssue(3);
      red.merge(9, "nibfin/issue-3", sha.m3, { CI: m3 });
      const before = await red.route(1);
      assert.ok(before.stage.stage === "done");
      assert.equal(before.stage.passedOn?.mergeCommitSha, sha.f);
      assert.equal((await red.stage(2)).stage, "done");

      // A finishes: delivered and closed.
      const a = red.issues.get(2)!;
      a.state = "closed";
      a.labels.push("delivered");
      const closed = await red.cli("--issue", "2");
      assert.equal(closed.code, 0);
      const waking = closed.dispatched.filter(
        (inputs) => (inputs as { stage: string }).stage === "route",
      );
      assert.deepEqual(waking, m3 === null ? [routeRun(1)] : [routeRun(3), routeRun(1)]);
      const after = await red.route(1);
      assert.ok(after.stage.stage === "done");
      assert.equal(after.stage.passedOn?.mergeCommitSha, sha.f);
      assert.equal(c.state, "open");
    });
  }
});

describe("a failed workflow that did not run again (#772)", () => {
  it("a green head without the failed path does not finish the Issue", async () => {
    const red = await redMain();
    red.addIssue(2);
    red.merge(5, aBranch, sha.m1, { CI: "failure", Image: "failure" });
    red.merge(7, bBranch, sha.m2, { CI: "success" });
    assert.equal((await red.stage(1)).stage, "done");
    const a = await red.stage(2);
    assert.ok(a.stage === "cd-failed");
    assert.equal(a.failedOn, undefined);
    assert.deepEqual(
      a.runs.map((run) => run.name),
      ["CI", "Image"],
    );
  });

  it("a waiting Issue fixes a failed path the earlier fix did not re-run", async () => {
    const red = await twoRedMerges({ CI: "failure", Image: "failure" });
    red.merge(6, aFix, sha.f, { CI: "success" });
    const b = await red.stage(1);
    assert.ok(b.stage === "cd-failed");
    assert.equal(b.failedOn, undefined);
    assert.deepEqual(
      b.runs.map((run) => [run.name, run.conclusion]),
      [["Image", "failure"]],
    );
  });
});

describe("a closed fixer without a fix (#772)", () => {
  it("wakes the waiting Issue, which fixes its own merge", async () => {
    const red = await twoRedMerges();
    red.issues.get(2)!.state = "closed";
    const closed = await red.cli("--issue", "2");
    assert.equal(closed.code, 0);
    assert.deepEqual(closed.dispatched, [routeRun(1)]);
    const b = await red.stage(1);
    assert.ok(b.stage === "cd-failed");
    assert.equal(b.failedOn, undefined);
    assert.equal(b.pullRequest.mergeCommitSha, sha.m2);
    assert.deepEqual(
      b.runs.map((run) => [run.name, run.conclusion]),
      [["CI", "failure"]],
    );
  });

  it("wakes nobody while the closed Issue's CD runs, then on completion", async () => {
    const red = await redMain();
    red.addIssue(2);
    red.merge(5, aBranch, sha.m1, { CI: null });
    red.merge(7, bBranch, sha.m2, { CI: "failure" });
    assert.deepEqual(stageOf(await red.stage(1)), [
      "awaiting-cd",
      "previous-cd-pending",
      null,
    ]);
    red.issues.get(2)!.state = "closed";
    const closed = await red.cli("--issue", "2");
    assert.deepEqual(closed.dispatched, []);
    red.complete(sha.m1, { CI: "failure" });
    const completed = await red.cli("--sha", sha.m1);
    assert.deepEqual(completed.dispatched, [routeRun(2), routeRun(1)]);
    assert.equal((await red.stage(1)).stage, "cd-failed");
  });
});
