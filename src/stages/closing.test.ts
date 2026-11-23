import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import { checkRun, workflowRun } from "../github/fixtures.test.ts";
import { GitHubError } from "../github/index.ts";
import { branch } from "./fake-delivery.test.ts";
import {
  addDownstream,
  addPullComment,
  mergePull,
  type ReviewWorld,
  reviewWorld,
} from "./fake-review.test.ts";
import { fakeIssue, seedComment } from "./fake-job.test.ts";

const noNext = { stage: null, reason: null };

/** PR 7 merged with a failed CD, then fix PR 8 on `-cd-1` merged with CD passing. */
async function deliveredWorld(): Promise<ReviewWorld> {
  const w = await reviewWorld();
  mergePull(w, w.pull, "failure");
  const fix = {
    number: 8,
    state: "open" as const,
    merged: false,
    head: `${branch}-cd-1`,
    sha: "fix-head",
    mergeSha: null,
  };
  w.pulls.push(fix);
  mergePull(w, fix);
  return w;
}

function delivered(w: ReviewWorld): string[] {
  return w.issues.marked("delivered").map((comment) => comment.body);
}

describe("runReviewStage closing", () => {
  it("writes the closing comment from GitHub data, closes and wakes", async () => {
    const w = await deliveredWorld();
    w.required.push("build");
    w.pullCommits.set(7, ["c1", w.head]);
    w.checkRuns.set("c1", [checkRun(1, "build", { conclusion: "failure" })]);
    w.checkRuns.set(w.head, [checkRun(2, "build")]);
    w.checkRuns.set("fix-head", [checkRun(3, "build")]);
    // Before a rebase PR 7 had heads old-1 (on old-0) and one GitHub no longer has.
    w.forcePushes.set(7, ["old-1", "gone"]);
    w.ahead.set("old-1", ["old-0", "old-1", "c1"]);
    w.checkRuns.set("old-0", [checkRun(4, "build", { conclusion: "failure" })]);
    w.checkRuns.set("old-1", [checkRun(5, "build", { conclusion: "timed_out" })]);
    const review = addPullComment(w, 7, "<!-- nibfin:review -->\nReviewed head: c1");
    w.edits.set(review.id, 3);
    addPullComment(w, 8, "<!-- nibfin:review -->\nReviewed head: fix-head");
    const shape = addDownstream(w, { number: 2 });
    addDownstream(w, { number: 3, assignees: [] });
    addDownstream(w, { number: 4, labels: ["scope", "pause"] });
    const other = fakeIssue({ number: 9, state: "open" });
    addDownstream(w, { number: 5 }, { blockers: [w.issues.main, other] });
    addDownstream(w, { owner: "other", repo: "lib", number: 6 }, { readable: false });
    shape.labels.push("shaped");
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), {
      ...noNext,
      wake: [{ repo: "acme/app", issue: 2 }],
    });
    const url = "https://github.com/acme/app";
    assert.deepEqual(delivered(w), [
      [
        "<!-- nibfin:delivered -->",
        "Delivered: the merged work passed CD.",
        "",
        "### Pull requests",
        "",
        `- [#7](${url}/pull/7) \`${branch}\` → \`main\`: merged as \`merge-7\``,
        `- [#8](${url}/pull/8) \`${branch}-cd-1\` → \`main\`: merged as \`merge-8\``,
        "",
        "### CI (required checks of each merged head)",
        "",
        `- #7 at \`${w.head}\`: build: success (${url}/runs/2)`,
        `- #8 at \`fix-head\`: build: success (${url}/runs/3)`,
        "",
        "### CD",
        "",
        `- #7 merge \`merge-7\`: CD (\`.github/workflows/cd.yml\`): failure ` +
          `(${url}/actions/runs/27)`,
        `- #8 merge \`merge-8\`: CD (\`.github/workflows/cd.yml\`): success ` +
          `(${url}/actions/runs/28)`,
        "",
        "### Counts",
        "",
        "- CD-fix pull requests: 1",
        "- CI-fix rounds: 3",
        "- Review rounds: 4",
      ].join("\n"),
    ]);
    assert.equal(w.issues.main.state, "closed");
    assert.ok(w.issues.main.labels.includes("delivered"));
    const logs = w.agent.logs.join("\n");
    assert.match(logs, /#7: the force-pushed head gone is gone; not counted/);
    assert.match(logs, /Closed acme\/app#1 as delivered/);
    assert.match(logs, /Waking acme\/app#2 \(deliver\)/);
    assert.match(logs, /Not waking acme\/app#3: no-assignee/);
    assert.match(logs, /Not waking acme\/app#4: paused/);
    assert.match(logs, /Not waking acme\/app#5: blocked by .*issues\/9/);
    assert.match(logs, /Not waking other\/lib#6: it cannot be read/);
  });

  it("lists open and unmerged pull requests and runs without checks", async () => {
    const w = await reviewWorld();
    w.pulls.push({
      number: 6,
      state: "closed",
      merged: false,
      head: branch,
      sha: "old",
      mergeSha: null,
    });
    mergePull(w, w.pull);
    w.pushRuns.splice(1, 1);
    assert.equal(await w.review(), 0);
    const body = delivered(w)[0];
    assert.match(body, /#6\]\(.*\) `nibfin\/issue-1` → `main`: closed without merging/);
    assert.match(body, /- #7 at `[0-9a-f]+`: no required checks/);
    assert.match(body, /- #7 merge `merge-7`: no CD runs/);
    assert.match(body, /- Review rounds: 0/);
  });

  it("lists an open PR, an unknown merge commit and a check without a URL", async () => {
    const w = await deliveredWorld();
    w.required.push("build");
    const old = { state: "closed" as const, head: branch, mergeSha: null };
    w.pulls.push(
      { ...old, number: 5, merged: true, sha: "old-head" },
      { ...old, number: 9, state: "open", merged: false, sha: "open-head" },
    );
    assert.equal(await w.review(), 0);
    const body = delivered(w)[0];
    assert.match(body, /\[#5\].*: merged as `\(unknown\)`/);
    assert.match(body, /\[#9\].*: open\n/);
    assert.match(body, /- #5 merge `\(unknown\)`: no CD runs/);
    assert.match(body, /- #8 at `fix-head`: build: pending \(no URL\)/);
    assert.equal(w.issues.main.state, "closed");
  });

  it("waits for a CD run that appears after the closing comment", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull);
    const routes = w.issues.github.routes;
    const post = routes.get("POST /repos/acme/app/issues/1/comments")!;
    routes.set("POST /repos/acme/app/issues/1/comments", (request) => {
      w.pushRuns.push(
        workflowRun(99, {
          name: "Late",
          path: ".github/workflows/late.yml",
          status: "queued",
          conclusion: null,
          sha: "merge-7",
        }),
      );
      return typeof post === "function" ? post(request) : post;
    });
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), noNext);
    assert.equal(delivered(w).length, 1);
    assert.equal(w.issues.main.state, "open");
    assert.ok(!w.issues.main.labels.includes("delivered"));
    assert.match(w.agent.logs.at(-1)!, /Not closing .* awaiting-cd/);
  });

  it("does not hide an unexpected error while reading a downstream Issue", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull);
    // A Blocked by entry whose repository URL cannot be parsed.
    addDownstream(w, { number: 2 }, { blockers: [fakeIssue({ owner: "" })] });
    const error = await rejection(w.review());
    assert.ok(error instanceof TypeError);
    assert.equal(w.issues.main.state, "closed");
  });

  it("only wakes downstream on a redo after the close", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull);
    w.issues.main.state = "closed";
    w.issues.main.labels.push("delivered");
    seedComment(w.issues, w.issues.main, "<!-- nibfin:delivered -->\nDelivered.");
    addDownstream(w, { number: 2, labels: ["scope", "shaped"] });
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { ...noNext, wake: [{ repo: "acme/app", issue: 2 }] });
    assert.deepEqual(w.issues.github.writes(), []);
  });

  it("fails after the close when the downstream list cannot be read", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull);
    w.issues.github.routes.delete("GET /repos/acme/app/issues/1/dependencies/blocking");
    w.blocking.push(fakeIssue({ number: 2 }));
    const error = await rejection(w.review());
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
    assert.equal(w.issues.main.state, "closed");
    assert.deepEqual(w.next(), noNext);
  });
});

describe("runReviewStage dispatch", () => {
  it("waits for CD", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull);
    w.pushRuns.splice(
      1,
      1,
      workflowRun(30, { status: "in_progress", conclusion: null, sha: "merge-7" }),
    );
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), noNext);
    assert.deepEqual(w.agent.logs, ["acme/app#1 is waiting for CD (cd-runs-pending)"]);
  });

  it("asks for a CD-failure fix", async () => {
    const w = await reviewWorld();
    mergePull(w, w.pull, "failure");
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: "cd-failure" });
    assert.deepEqual(w.issues.github.writes(), []);
  });

  for (const [name, change, expected] of [
    [
      "closed without delivered",
      (w: ReviewWorld) => {
        w.issues.main.state = "closed";
        w.issues.main.labels.push("delivered");
      },
      "ineligible (closed)",
    ],
    [
      "closed and unlabeled",
      (w: ReviewWorld) => {
        w.issues.main.state = "closed";
      },
      "ineligible (closed)",
    ],
    [
      "waiting for CI",
      (w: ReviewWorld) => {
        w.required.push("build");
      },
      "awaiting-ci",
    ],
  ] as const) {
    it(`does nothing when ${name}`, async () => {
      const w = await reviewWorld();
      change(w);
      assert.equal(await w.review(), 0);
      assert.deepEqual(w.next(), noNext);
      assert.deepEqual(w.agent.logs, [
        `acme/app#1 is not at the review stage: ${expected}`,
      ]);
      assert.deepEqual(w.issues.github.writes(), []);
    });
  }
});
