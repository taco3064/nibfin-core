import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fakeActor, fakeToken, paged, rejection } from "../github/fake-github.test.ts";
import { checkRun } from "../github/fixtures.test.ts";
import { conflictDelayMs, conflictReads } from "./deliver-eligibility.ts";
import { StageError } from "./errors.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  failedActionsCheck,
  failedCd,
  type WorldOptions,
} from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import { agentResult, type AgentStep, shapeVersion } from "./fake-job.test.ts";

const done = agentResult({ outcome: "done" });
const pass = agentResult({ outcome: "pass" });
const fixBranch = `${branch}-cd-1`;

function next(world: DeliveryWorld): unknown {
  return JSON.parse(readFileSync(world.nextFile, "utf8"));
}

function pushes(world: DeliveryWorld) {
  return world.git.calls.filter((call) => call.args.includes("push"));
}

/** A world whose Issue branch is pushed and has open PR #7 at its head. */
async function openPullWorld(options: WorldOptions) {
  const world = await deliveryWorld(options);
  const { other } = world.fixture;
  git(other, "checkout", "--quiet", "-b", branch);
  const head = commitFile(other, "a.txt", "a\n", "feat: a");
  git(other, "push", "--quiet", "origin", branch);
  world.pulls.push({
    number: 7,
    state: "open",
    merged: false,
    head: branch,
    sha: head,
    mergeSha: null,
  });
  return { world, head };
}

/** A Writer that commits once; the remote must not have moved meanwhile. */
function fixingWriter(get: () => DeliveryWorld, before: () => string): AgentStep {
  return () => {
    commitFile(get().fixture.workspace, "fix.txt", "fix\n", "fix: the failure");
    assert.equal(get().fixture.remoteHead(branch), before());
    return done;
  };
}

const logLines = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`);

describe("runDeliverStage for ci-failure", () => {
  it("fixes the failed checks and updates the PR only after Accept", async () => {
    const accept: AgentStep = () => {
      assert.equal(world.fixture.remoteHead(branch), head);
      return pass;
    };
    const { world, head } = await openPullWorld({
      reason: "ci-failure",
      steps: [
        fixingWriter(
          () => world,
          () => head,
        ),
        accept,
      ],
    });
    world.required.push("verify", "lint", "docs");
    world.checkRuns.set(head, [
      failedActionsCheck(55, "verify"),
      checkRun(56, "lint", { appId: 1, conclusion: "failure", slug: "circleci" }),
      { ...checkRun(57, "docs", { appId: 2, conclusion: "failure" }), html_url: null },
    ]);
    world.issues.github.routes.set("GET /repos/acme/app/actions/jobs/55/logs", {
      data: `${logLines.join("\n")}\ntoken ${fakeToken}\n`,
    });
    assert.equal(await world.run(), 0);
    const local = git(world.fixture.workspace, "rev-parse", "HEAD");
    assert.equal(world.fixture.remoteHead(branch), local);
    assert.equal(pushes(world).length, 1);
    assert.ok(
      pushes(world)[0].args.includes(`--force-with-lease=refs/heads/${branch}:${head}`),
    );
    assert.equal(world.pulls.length, 1);
    assert.ok(
      !world.issues.github
        .writes()
        .some((call) => call.method === "POST" && call.path.endsWith("/pulls")),
    );
    const [writerRun, acceptorRun] = world.agent.runs;
    for (const run of [writerRun, acceptorRun]) {
      assert.match(run.prompt, /## Fix reason\n\nReason: ci-failure/);
      assert.match(run.prompt, /Pull request: https:\/\/github\.com\/acme\/app\/pull\/7/);
      assert.match(
        run.prompt,
        /### verify\n\nURL: https:\/\/github\.com\/acme\/app\/runs\/55/,
      );
      assert.match(run.prompt, /\nline 52\n/);
      assert.doesNotMatch(run.prompt, /\nline 51\n/);
      assert.match(run.prompt, /token \*\*\*/);
      assert.ok(!run.prompt.includes(fakeToken));
      assert.match(run.prompt, /### lint\n\nURL: .*\n\nNot a GitHub Actions job/);
      assert.match(run.prompt, /### docs\n\nURL: \(none\)\n\nNot a GitHub Actions job/);
    }
    assert.match(writerRun.prompt, /Fix what the fix reason below points at/);
    assert.match(writerRun.prompt, /pushes only after a fresh Accept passes/);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: true });
  });

  it("pushes nothing when the Writer is blocked on an open PR", async () => {
    const blocked = agentResult({ outcome: "blocked", reason: "Flaky runner" });
    const step: AgentStep = () => {
      commitFile(world.fixture.workspace, "fix.txt", "fix\n", "fix: partial");
      return blocked;
    };
    const { world, head } = await openPullWorld({ reason: "ci-failure", steps: [step] });
    world.required.push("verify");
    world.checkRuns.set(head, [failedActionsCheck(55, "verify")]);
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), head);
  });

  it("is ineligible without a failed check", async () => {
    const { world } = await openPullWorld({ reason: "ci-failure" });
    assert.equal(await world.run(), 0);
    assert.deepEqual(world.agent.logs, [
      "acme/app#1 is not at the deliver stage: review (ci-failure)",
    ]);
  });
});

const reviewBody = (sha: string, version = "1.1") =>
  `<!-- nibfin:review -->\nReviewed head: ${sha}\nReviewed Shape: ${version}\n\n` +
  "Rename the widget.";

describe("runDeliverStage for review", () => {
  it("fixes the review comment on the reviewed head", async () => {
    const { world, head } = await openPullWorld({
      reason: "review",
      steps: [
        fixingWriter(
          () => world,
          () => head,
        ),
        pass,
      ],
    });
    const body = reviewBody(head, shapeVersion(world.issues));
    world.pullComments.set(7, [{ id: 9, userId: fakeActor.id, body }]);
    assert.equal(await world.run(), 0);
    const [writerRun] = world.agent.runs;
    assert.match(
      writerRun.prompt,
      /Review comment: https:\/\/github\.com\/acme\/app\/pull\/7#issuecomment-9/,
    );
    assert.match(writerRun.prompt, /Rename the widget\./);
    assert.equal(pushes(world).length, 1);
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
  });

  for (const [name, comments] of [
    [
      "an older head",
      (head: string) => [
        {
          id: 9,
          userId: fakeActor.id,
          body: reviewBody(`${head[0] === "0" ? "1" : "0"}${head.slice(1)}`),
        },
      ],
    ],
    [
      "no head line",
      () => [{ id: 9, userId: fakeActor.id, body: "<!-- nibfin:review -->\nok" }],
    ],
    ["another author", (head: string) => [{ id: 9, userId: 5, body: reviewBody(head) }]],
  ] as const) {
    it(`is ineligible for a review comment with ${name}`, async () => {
      const { world, head } = await openPullWorld({ reason: "review" });
      world.pullComments.set(7, comments(head));
      assert.equal(await world.run(), 0);
      assert.deepEqual(world.agent.logs, [
        "acme/app#1 is not at the deliver stage: review (review)",
      ]);
    });
  }
});

describe("runDeliverStage for conflict", () => {
  /** PR #7 conflicts with `main`, which gained a commit of PR #330 on `a.txt`. */
  async function conflictWorld(steps: AgentStep[]) {
    const { world, head } = await openPullWorld({ reason: "conflict", steps });
    const { other } = world.fixture;
    git(other, "checkout", "--quiet", "main");
    const base = commitFile(other, "a.txt", "base\n", "feat: base a");
    git(other, "push", "--quiet", "origin", "main");
    world.commitPulls.set(base, [
      { number: 330, title: "Base a", html_url: "https://github.com/acme/app/pull/330" },
    ]);
    // GitHub finds the PR conflicting until its head changes.
    Object.defineProperty(world.pulls[0], "mergeable", {
      configurable: true,
      get: () => (world.fixture.remoteHead(branch) === head ? false : true),
    });
    return { world, head, base };
  }

  it("rebases onto the base it lists and updates the PR after Accept", async () => {
    const rebase: AgentStep = (options) => {
      git(options.workspace, "reset", "--quiet", "--hard", "refs/remotes/origin/main");
      commitFile(options.workspace, "a.txt", "base\na\n", "feat: a");
      return done;
    };
    const { world, head, base } = await conflictWorld([rebase, pass]);
    assert.equal(await world.run(), 0);
    const [writerRun, acceptorRun] = world.agent.runs;
    for (const run of [writerRun, acceptorRun]) {
      assert.match(run.prompt, /## Fix reason\n\nReason: conflict/);
      assert.match(run.prompt, /Pull request: https:\/\/github\.com\/acme\/app\/pull\/7/);
      assert.match(run.prompt, /It conflicts with `main`\. Rebase the branch onto/);
      const short = git(world.fixture.workspace, "rev-parse", "--short", base);
      assert.ok(
        run.prompt.includes(
          `- ${short} feat: base a\n` +
            "  - Pull request #330: Base a (https://github.com/acme/app/pull/330)",
        ),
      );
    }
    const local = git(world.fixture.workspace, "rev-parse", "HEAD");
    assert.equal(world.fixture.remoteHead(branch), local);
    assert.equal(pushes(world).length, 1);
    assert.ok(
      pushes(world)[0].args.includes(`--force-with-lease=refs/heads/${branch}:${head}`),
    );
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
  });

  it("re-reads while GitHub computes mergeable, then fixes the conflict", async () => {
    const rebase: AgentStep = (options) => {
      git(options.workspace, "reset", "--quiet", "--hard", "refs/remotes/origin/main");
      commitFile(options.workspace, "a.txt", "base\na\n", "feat: a");
      return done;
    };
    const { world, head } = await conflictWorld([rebase, pass]);
    // GitHub is still computing until Deliver has waited twice (#751).
    Object.defineProperty(world.pulls[0], "mergeable", {
      get: () => {
        if (world.waits.length < 2) {
          return null;
        }
        return world.fixture.remoteHead(branch) === head ? false : true;
      },
    });
    assert.equal(await world.run(), 0);
    assert.equal(world.agent.runs.length, 2);
    assert.deepEqual(world.waits.slice(0, 2), [conflictDelayMs, conflictDelayMs]);
  });

  it("names GitHub's computing state when mergeable stays unknown", async () => {
    const { world } = await openPullWorld({ reason: "conflict" });
    world.pulls[0].mergeable = null;
    assert.equal(await world.run(), 0);
    assert.deepEqual(world.agent.logs, [
      "acme/app#1 is not at the deliver stage: review (conflict); GitHub has not " +
        "computed whether https://github.com/acme/app/pull/7 conflicts with its base yet",
    ]);
    assert.deepEqual(
      world.waits,
      Array.from({ length: conflictReads - 1 }, () => conflictDelayMs),
    );
  });

  it("is ineligible while the pull request does not conflict", async () => {
    const { world } = await openPullWorld({ reason: "conflict" });
    assert.equal(await world.run(), 0);
    assert.deepEqual(world.agent.logs, [
      "acme/app#1 is not at the deliver stage: review (conflict)",
    ]);
  });
});

describe("runDeliverStage for cd-failure", () => {
  function routeJobs(world: DeliveryWorld) {
    const job = (id: number, conclusion: string) => ({
      id,
      name: `deploy ${id}`,
      status: "completed",
      conclusion,
      html_url: id === 33 ? null : `https://github.com/acme/app/actions/runs/2/job/${id}`,
    });
    const { routes } = world.issues.github;
    routes.set(
      "GET /repos/acme/app/actions/runs/2/jobs",
      paged([job(31, "failure"), job(32, "success"), job(33, "failure")], "jobs"),
    );
    routes.set("GET /repos/acme/app/actions/jobs/31/logs", { data: "deploy failed\n" });
  }

  it("works on the next fix branch from the latest base and opens a new PR", async () => {
    const step: AgentStep = (options) => {
      assert.equal(git(options.workspace, "symbolic-ref", "--short", "HEAD"), fixBranch);
      commitFile(options.workspace, "fix.txt", "fix\n", "fix: deploy");
      return done;
    };
    const world = await deliveryWorld({ reason: "cd-failure", steps: [step, pass] });
    failedCd(world);
    routeJobs(world);
    const main = commitFile(world.fixture.other, "m.txt", "m\n", "newer main");
    git(world.fixture.other, "push", "--quiet", "origin", "main");
    assert.equal(await world.run(), 0);
    assert.equal(git(world.fixture.remote, "rev-parse", `${fixBranch}~1`), main);
    const [pull] = world.pulls.filter((candidate) => candidate.head === fixBranch);
    assert.equal(pull?.body, "Part of #1");
    const [writerRun] = world.agent.runs;
    assert.match(writerRun.prompt, /Work on branch `nibfin\/issue-1-cd-1`/);
    assert.match(
      writerRun.prompt,
      /Merged pull request: https:\/\/github\.com\/acme\/app\/pull\/5/,
    );
    assert.match(writerRun.prompt, /### CD \(\.github\/workflows\/ci\.yml\)/);
    assert.match(
      writerRun.prompt,
      new RegExp(
        "#### Job deploy 31\n\nURL: .*\n\nJob log excerpt \\(1 of 1 lines\\):\n\n" +
          "Lines 1–1:\n\n```text\ndeploy failed\n```\n\n",
      ),
    );
    assert.match(
      writerRun.prompt,
      /#### Job deploy 33\n\nURL: \(none\)\n\nThe job log is not available\./,
    );
    assert.doesNotMatch(writerRun.prompt, /deploy 32/);
  });

  it("redoes the fix on a pushed fix branch without a PR", async () => {
    const world = await deliveryWorld({
      reason: "cd-failure",
      steps: [new Error("stop")],
    });
    failedCd(world);
    routeJobs(world);
    // A newer merged PR without a merge commit has no CD to report.
    world.pulls.push({
      number: 6,
      state: "closed",
      merged: true,
      head: branch,
      sha: "head-6",
      mergeSha: null,
    });
    const { other } = world.fixture;
    git(other, "checkout", "--quiet", "-b", fixBranch);
    commitFile(other, "fix.txt", "fix\n", "fix: earlier");
    git(other, "push", "--quiet", "origin", fixBranch);
    await rejection(world.run());
    assert.equal(
      git(world.fixture.workspace, "symbolic-ref", "--short", "HEAD"),
      fixBranch,
    );
    assert.match(world.agent.runs[0].prompt, /Merged pull request: .*\/pull\/5/);
  });

  it("says when no merged PR with a failed CD run is found", async () => {
    const world = await deliveryWorld({
      reason: "cd-failure",
      steps: [new Error("stop")],
    });
    const { other } = world.fixture;
    git(other, "checkout", "--quiet", "-b", fixBranch);
    commitFile(other, "fix.txt", "fix\n", "fix: earlier");
    git(other, "push", "--quiet", "origin", fixBranch);
    await rejection(world.run());
    assert.match(
      world.agent.runs[0].prompt,
      /No merged pull request with a failed CD run/,
    );
  });

  it("is ineligible on the delivery branch", async () => {
    const world = await deliveryWorld({ reason: "cd-failure" });
    assert.equal(await world.run(), 0);
    assert.deepEqual(world.agent.logs, [
      "acme/app#1 is not at the deliver stage: deliver (cd-failure)",
    ]);
  });
});

describe("runDeliverStage stops between rounds", () => {
  it("reports a pushed branch that moved during an open-PR fix", async () => {
    const racing: AgentStep = () => {
      const { other } = world.fixture;
      commitFile(other, "z.txt", "z\n", "someone else");
      git(other, "push", "--quiet", "origin", branch);
      commitFile(world.fixture.workspace, "fix.txt", "fix\n", "fix: it");
      return done;
    };
    const { world, head } = await openPullWorld({
      reason: "ci-failure",
      steps: [racing, pass],
    });
    world.required.push("verify");
    world.checkRuns.set(head, [failedActionsCheck(55, "verify")]);
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_PUSH_REJECTED");
    assert.equal(world.pulls.length, 1);
  });
});
