import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, paged } from "../github/fake-github.test.ts";
import { pull as pullJson } from "../github/fixtures.test.ts";
import { fakeIssue, fakeIssues } from "../stages/fake-job.test.ts";
import { readPendingCause, requestPerson } from "../stages/pending.ts";
import { StageError } from "../stages/errors.ts";
import { dispatchPath, fakeRunner } from "./fake-runner.test.ts";
import { runWake, type WakeInput, type WakePayload, wakeOf } from "./wake.ts";

const repo = { owner: "acme", repo: "app" };
const runner = "acme/runner";
const runRepo = { owner: "acme", repo: "runner" };
const url = "https://github.com/acme/app/actions/runs/77";
const sha = "abc1234";

function decide(
  name: string,
  payload: WakePayload,
  execution: string | undefined = runner,
) {
  return wakeOf(name, payload, repo, execution);
}

function skips(name: string, payload: WakePayload, reason: string) {
  assert.deepEqual(decide(name, payload), { kind: "skip", reason });
}

function wakes(name: string, payload: WakePayload, target: unknown, writer?: string) {
  assert.deepEqual(decide(name, payload), {
    kind: "wake",
    executionRepo: runRepo,
    target,
    writer,
  });
}

function rejects(run: () => unknown, message: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_INPUT_INVALID");
    assert.equal(error.message, message);
    return true;
  });
}

const notSet = "The variable NIBFIN_EXECUTION_REPO is not set (input execution-repo)";
const labels = (...names: string[]) => names.map((name) => ({ name }));
const issueEvent = (overrides: WakePayload = {}): WakePayload => ({
  action: "opened",
  sender: { login: "ann" },
  issue: { number: 1, labels: labels("scope") },
  ...overrides,
});
const review = (ref: string | undefined, fullName: string | null = "acme/app") => ({
  sender: { login: "ann" },
  pull_request: {
    head: { ref, repo: fullName === null ? null : { full_name: fullName } },
  },
});
const pullRun = (branch: string | null, fullName: string | null = "acme/app") => ({
  workflow_run: {
    event: "pull_request",
    head_branch: branch,
    head_sha: sha,
    head_repository: fullName === null ? null : { full_name: fullName },
  },
});

describe("wakeOf execution repository", () => {
  it("is required first by every event but a review", () => {
    for (const name of ["issues", "push", "status", "deployment"]) {
      rejects(() => wakeOf(name, issueEvent(), repo, undefined), notSet);
      rejects(() => decide(name, issueEvent(), " "), notSet);
    }
    rejects(
      () => decide("issues", issueEvent(), "runner"),
      "NIBFIN_EXECUTION_REPO must be <owner>/<repo>",
    );
  });

  it("is required by a review only after the review filter", () => {
    const skipped = wakeOf("pull_request_review", review("feature"), repo, undefined);
    assert.equal(skipped.kind, "skip");
    const fork = decide("pull_request_review", review("nibfin/issue-1", "x/y"), "");
    assert.equal(fork.kind, "skip");
    rejects(() => decide("pull_request_review", review("nibfin/issue-1"), ""), notSet);
  });
});

describe("wakeOf issues", () => {
  it("wakes an Issue with scope or request for its sender", () => {
    wakes("issues", issueEvent(), { issue: 1 }, "ann");
    const request = issueEvent({ issue: { number: 1, labels: labels("request") } });
    wakes("issues", request, { issue: 1 }, "ann");
    for (const action of ["assigned", "unassigned", "closed", "reopened"]) {
      wakes("issues", issueEvent({ action }), { issue: 1 }, "ann");
    }
  });

  it("skips an Issue without scope or request", () => {
    const reason = "acme/app#1 has no scope or request label; not routed";
    const shaped = issueEvent({ issue: { number: 1, labels: labels("shaped") } });
    skips("issues", shaped, reason);
    skips("issues", issueEvent({ issue: { number: 1 } }), reason);
  });

  it("skips Nibfin's own shaped and delivered label changes only", () => {
    const open = { number: 1, state: "open", labels: labels("scope") };
    for (const action of ["labeled", "unlabeled"]) {
      for (const name of ["shaped", "delivered"]) {
        const event = issueEvent({ action, label: { name }, issue: open });
        skips(
          "issues",
          event,
          `Nibfin's own label change (${action} ${name}); not routed`,
        );
      }
      for (const name of ["scope", "pause", "pending"]) {
        wakes("issues", issueEvent({ action, label: { name } }), { issue: 1 }, "ann");
      }
    }
    const opened = issueEvent({ label: { name: "shaped" } });
    wakes("issues", opened, { issue: 1 }, "ann");
    wakes("issues", issueEvent({ action: "labeled" }), { issue: 1 }, "ann");
  });

  it("wakes when delivered is added to an Issue that is not open", () => {
    const delivered = { action: "labeled", label: { name: "delivered" } };
    const closed = { number: 1, state: "closed", labels: labels("scope", "delivered") };
    wakes("issues", issueEvent({ ...delivered, issue: closed }), { issue: 1 }, "ann");
    const unknown = { number: 1, labels: labels("scope", "delivered") };
    wakes("issues", issueEvent({ ...delivered, issue: unknown }), { issue: 1 }, "ann");
    for (const [action, name] of [
      ["unlabeled", "delivered"],
      ["labeled", "shaped"],
      ["unlabeled", "shaped"],
    ]) {
      skips(
        "issues",
        issueEvent({ action, label: { name }, issue: closed }),
        `Nibfin's own label change (${action} ${name}); not routed`,
      );
    }
  });

  it("rejects an event without its Issue or sender", () => {
    rejects(() => decide("issues", {}), "The issues event has no issue");
    rejects(
      () => decide("issues", issueEvent({ sender: {} })),
      "The issues event has no sender",
    );
  });
});

describe("wakeOf pull_request_review", () => {
  it("wakes the branch of a same-repository Nibfin pull request for its sender", () => {
    const event = "pull_request_review";
    wakes(event, review("nibfin/issue-3"), { branch: "nibfin/issue-3" }, "ann");
  });

  it("skips other branches and pull requests from other repositories", () => {
    const event = "pull_request_review";
    const other = "A review on a pull request that is not Nibfin's; not routed";
    skips(event, review("feature"), other);
    skips(event, review(undefined), other);
    skips(event, {}, other);
    skips(
      event,
      review("nibfin/issue-3", "fork/app"),
      "A review on a pull request from fork/app; not routed",
    );
    skips(
      event,
      review("nibfin/issue-3", null),
      "A review on a pull request from an unknown repository; not routed",
    );
  });

  it("rejects a review without its sender", () => {
    const { pull_request } = review("nibfin/issue-3");
    rejects(
      () => decide("pull_request_review", { pull_request }),
      "The pull_request_review event has no sender",
    );
  });
});

describe("wakeOf workflow_run", () => {
  it("wakes the branch of a same-repository Nibfin pull request run", () => {
    wakes("workflow_run", pullRun("nibfin/issue-4-cd-1"), {
      branch: "nibfin/issue-4-cd-1",
    });
  });

  it("never falls back to the commit of a filtered pull request run", () => {
    const other = "A run of a pull request that is not Nibfin's; not routed";
    skips("workflow_run", pullRun("feature"), other);
    skips("workflow_run", pullRun(null), other);
    skips(
      "workflow_run",
      pullRun("nibfin/issue-4", "fork/app"),
      "A pull request from fork/app; not routed",
    );
    skips(
      "workflow_run",
      pullRun("nibfin/issue-4", null),
      "A pull request from an unknown repository; not routed",
    );
  });

  it("wakes the head commit of any other run", () => {
    const run = { event: "push", head_branch: "main", head_sha: sha };
    wakes("workflow_run", { workflow_run: run }, { sha });
  });

  it("rejects a run without its head commit", () => {
    const message = "The workflow_run event has no head_sha";
    rejects(() => decide("workflow_run", { workflow_run: { event: "push" } }), message);
    rejects(() => decide("workflow_run", {}), message);
  });
});

describe("wakeOf check_suite, status and push", () => {
  it("wakes the branch of a check suite of another app", () => {
    const suite = { app: { slug: "ci-app" }, head_branch: "nibfin/issue-5" };
    wakes("check_suite", { check_suite: suite }, { branch: "nibfin/issue-5" });
    const noApp = { app: null, head_branch: "main" };
    wakes("check_suite", { check_suite: noApp }, { branch: "main" });
  });

  it("skips a check suite of GitHub Actions or of no branch", () => {
    const reason = "A check suite of GitHub Actions or of no branch; not routed";
    const actions = { app: { slug: "github-actions" }, head_branch: "nibfin/issue-5" };
    skips("check_suite", { check_suite: actions }, reason);
    for (const branch of [null, ""]) {
      const suite = { app: { slug: "ci-app" }, head_branch: branch };
      skips("check_suite", { check_suite: suite }, reason);
    }
    skips("check_suite", {}, reason);
  });

  it("wakes the commit of a status", () => {
    wakes("status", { sha }, { sha });
    rejects(() => decide("status", {}), "The status event has no sha");
  });

  it("wakes the new commit of a push to the default branch only", () => {
    const main = { default_branch: "main" };
    wakes("push", { repository: main, ref: "refs/heads/main", after: sha }, { sha });
    const reason = "A push to a branch that is not the default branch; not routed";
    skips("push", { repository: main, ref: "refs/heads/feature", after: sha }, reason);
    skips("push", { repository: main, ref: "refs/tags/main", after: sha }, reason);
    skips("push", { ref: "refs/heads/main", after: sha }, reason);
    rejects(
      () => decide("push", { repository: main, ref: "refs/heads/main" }),
      "The push event has no after",
    );
  });

  it("does not route any other event", () => {
    skips("pull_request", {}, "The pull_request event is not routed");
  });
});

/** A fake GitHub with acme/app#1 (`labels`) and the execution repository. */
function wakeWorld(issueLabels = ["scope"], permission = "write") {
  const issues = fakeIssues(fakeIssue({ labels: issueLabels }), [
    fakeIssue({ number: 2, labels: ["scope", "pending"] }),
  ]);
  const { github } = issues;
  github.routes.set("GET /repos/acme/app/collaborators/ann/permission", {
    data: { permission },
  });
  const run = fakeRunner(github);
  const logs: string[] = [];
  let connects = 0;
  const wake = (eventName: string, payload: WakePayload, execution = runner) => {
    const input: WakeInput = {
      eventName,
      payload,
      repo,
      executionRepo: execution,
      url,
    };
    const connect = () => {
      connects += 1;
      return Promise.resolve(github.client);
    };
    return runWake(input, connect, (line) => logs.push(line));
  };
  return { issues, github, run, logs, wake, connects: () => connects };
}

/** Commit `sha` belongs to the pull requests of acme/app#1 and #2. */
function commitOfBoth(world: ReturnType<typeof wakeWorld>) {
  const { routes } = world.github;
  routes.set(
    `GET /repos/acme/app/commits/${sha}/pulls`,
    paged([
      pullJson(10, { head: "nibfin/issue-1", merged: true }),
      pullJson(11, { head: "nibfin/issue-2", merged: true }),
    ]),
  );
  routes.set(`GET /repos/acme/app/git/commits/${sha}`, {
    data: { sha, committer: { date: "2026-11-26T19:34:27Z" } },
  });
}

const pushEvent = {
  repository: { default_branch: "main" },
  ref: "refs/heads/main",
  after: sha,
};

describe("runWake", () => {
  it("logs a skipped event without connecting", async () => {
    const world = wakeWorld();
    await world.wake("pull_request", {});
    assert.deepEqual(world.logs, ["The pull_request event is not routed"]);
    assert.equal(world.connects(), 0);
  });

  it("dispatches a route run of the Issue once its sender may write", async () => {
    const world = wakeWorld();
    await world.wake("issues", issueEvent());
    assert.deepEqual(world.run.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
    assert.equal(world.connects(), 1);
    assert.match(world.logs.at(-1)!, /^Dispatched Nibfin · acme\/app#1 · route: /);
  });

  it("dispatches a commit or branch target without a permission check", async () => {
    const world = wakeWorld([], "read");
    await world.wake("push", pushEvent);
    await world.wake("workflow_run", pullRun("nibfin/issue-4"));
    assert.deepEqual(world.run.dispatched, [
      { stage: "route", repo: "acme/app", sha, ref: sha },
      {
        stage: "route",
        repo: "acme/app",
        branch: "nibfin/issue-4",
        ref: "nibfin/issue-4",
      },
    ]);
    const permission = world.github.calls.filter((call) =>
      call.path.includes("/collaborators/"),
    );
    assert.deepEqual(permission, []);
  });

  it("routes nothing for a sender without write permission", async () => {
    const world = wakeWorld(["scope"], "read");
    await world.wake("pull_request_review", review("nibfin/issue-1"));
    assert.deepEqual(world.run.dispatched, []);
    assert.deepEqual(world.logs, ["ann has no admin or write permission; not routed"]);
  });

  it("asks a person on the Issue with the dispatch failure's own code", async () => {
    const world = wakeWorld();
    world.github.routes.set(`POST ${dispatchPath}`, failure(422, "Unexpected inputs"));
    await assert.rejects(world.wake("issues", issueEvent()), {
      code: "GITHUB_WRITE_REJECTED",
    });
    const [comment] = world.issues.marked("pending");
    const cause = readPendingCause(comment.body);
    assert.equal(cause.code, "GITHUB_WRITE_REJECTED");
    assert.equal(cause.run, url);
    assert.equal(cause.temporary, false);
    assert.ok(world.issues.main.labels.includes("pending"));
    assert.equal(world.logs.at(-1), "Added pending to acme/app#1");
  });

  it("keeps the temporary note for a failure without an answer", async () => {
    const world = wakeWorld();
    world.github.routes.set(`POST ${dispatchPath}`, failure(502));
    await assert.rejects(world.wake("issues", issueEvent()));
    const cause = readPendingCause(world.issues.marked("pending")[0].body);
    assert.equal(cause.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(cause.temporary, true);
  });

  it("asks a person when the permission cannot be read", async () => {
    const world = wakeWorld();
    world.github.routes.set(
      "GET /repos/acme/app/collaborators/ann/permission",
      failure(500),
    );
    await assert.rejects(world.wake("issues", issueEvent()), {
      code: "GITHUB_READ_FAILED",
    });
    const cause = readPendingCause(world.issues.marked("pending")[0].body);
    assert.equal(cause.code, "GITHUB_READ_FAILED");
    assert.deepEqual(world.run.dispatched, []);
  });

  it("leaves a standing stop as it is", async () => {
    const world = wakeWorld(["scope", "pending"]);
    const standing = new StageError("STAGE_GIT_FAILED", "git failed");
    await requestPerson(world.github.client, world.issues.main, standing, "earlier");
    world.github.routes.set(`POST ${dispatchPath}`, failure(422));
    await assert.rejects(world.wake("issues", issueEvent()));
    const [comment] = world.issues.marked("pending");
    assert.equal(readPendingCause(comment.body).code, "STAGE_GIT_FAILED");
    assert.equal(world.logs.at(-1), "acme/app#1: Nibfin's stop stands; left as it is");
  });

  it("asks once on every Issue of a failed commit wake", async () => {
    const world = wakeWorld();
    commitOfBoth(world);
    world.github.routes.set(`POST ${dispatchPath}`, failure(422));
    await assert.rejects(world.wake("push", pushEvent));
    assert.equal(world.issues.marked("pending").length, 1);
    assert.deepEqual(world.issues.blockers[0].comments, []);
    assert.deepEqual(world.logs.slice(-2), [
      "Added pending to acme/app#1",
      "acme/app#2: Nibfin's stop stands; left as it is",
    ]);
  });

  it("writes nothing when the failed target belongs to no Issue", async () => {
    const world = wakeWorld();
    world.github.routes.set(`POST ${dispatchPath}`, failure(422));
    await assert.rejects(
      world.wake("check_suite", { check_suite: { head_branch: "x" } }),
    );
    assert.deepEqual(world.issues.marked("pending"), []);
    assert.equal(
      world.logs.at(-1),
      "The wake failed and belongs to no Issue; no pending added",
    );
  });

  it("writes nothing when the failed target's Issues cannot be read", async () => {
    const world = wakeWorld();
    world.github.routes.set(`POST ${dispatchPath}`, failure(422));
    world.github.routes.set(`GET /repos/acme/app/commits/${sha}/pulls`, failure(500));
    await assert.rejects(world.wake("status", { sha }), {
      code: "GITHUB_WRITE_REJECTED",
    });
    assert.deepEqual(world.issues.marked("pending"), []);
    const line = world.logs.at(-1)!;
    assert.ok(line.startsWith("The wake failed and its Issues could not be read ("));
    assert.ok(line.includes("(GITHUB_READ_FAILED: "));
    assert.ok(line.endsWith("); no pending added"));
  });

  it("goes on to the next Issue when one cannot be asked", async () => {
    const world = wakeWorld();
    commitOfBoth(world);
    world.github.routes.set(`POST ${dispatchPath}`, failure(422));
    world.github.routes.set("POST /repos/acme/app/issues/1/comments", failure(422));
    await assert.rejects(world.wake("push", pushEvent), {
      code: "GITHUB_WRITE_REJECTED",
    });
    assert.match(world.logs.at(-2)!, /^Could not add pending to acme\/app#1: GITHUB_/);
    assert.equal(world.logs.at(-1), "acme/app#2: Nibfin's stop stands; left as it is");
  });
});
