import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, fakeToken, paged } from "../github/fake-github.test.ts";
import { pull } from "../github/fixtures.test.ts";
import { freshReads, GitHubError } from "../github/index.ts";
import { fakeBranches } from "../route/fake-branches.test.ts";
import { fakeRunner } from "../route/fake-runner.test.ts";
import {
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  seedComment,
} from "../stages/fake-job.test.ts";
import { capture } from "./fake-io.test.ts";
import { readRouteInput } from "./route.ts";
import type { RunDeps } from "./run.ts";

const env: NodeJS.ProcessEnv = {
  NIBFIN_GITHUB_TOKEN: fakeToken,
  NIBFIN_RUN_REPO: "acme/runner",
  NIBFIN_RUN_ID: "900",
};

function routeDeps(overrides: Partial<FakeIssue> = {}) {
  const issues = fakeIssues(fakeIssue(overrides));
  const runner = fakeRunner(issues.github);
  const tokens: string[] = [];
  const deps: RunDeps = {
    env,
    connect: (token) => {
      tokens.push(token);
      return Promise.resolve(issues.github.client);
    },
    stages: {
      shape: () => Promise.reject(new Error("no stage runs in a route run")),
      deliver: () => Promise.reject(new Error("no stage runs in a route run")),
      review: () => Promise.reject(new Error("no stage runs in a route run")),
    },
  };
  return { issues, runner, deps, tokens };
}

const route = ["route", "--repo", "acme/app"];

describe("nibfin route --issue", () => {
  it("dispatches the Issue's stage with the token's client", async () => {
    const t = routeDeps({ labels: ["scope"] });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.tokens, [fakeToken]);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "shape", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    assert.match(result.stdout, /^Dispatched Nibfin · acme\/app#1 · shape: https:/);
    assert.ok(!result.stdout.includes(fakeToken));
  });

  it("dispatches nothing for an Issue that waits for a person", async () => {
    const t = routeDeps({ labels: ["scope", "pending"] });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "acme/app#1: nothing to run (ineligible (pending))\n");
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("writes nothing when no runner has the Assignee's label", async () => {
    const t = routeDeps({ labels: ["scope"] });
    t.runner.runners = [];
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, []);
    assert.deepEqual(t.issues.github.writes(), []);
    assert.equal(
      result.stdout,
      "acme/app#1: no runner of the execution repository has the label nibfin-5; " +
        "an ordinary assignment, nothing dispatched\n",
    );
  });

  it("asks for exactly one Assignee with pending, and exits 0", async () => {
    const assignees = [
      { id: 5, login: "taco" },
      { id: 6, login: "other" },
      { id: 7, login: "third" },
    ];
    const t = routeDeps({ labels: ["scope", "shaped"], assignees });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.deepEqual(result, {
      code: 0,
      stdout: "acme/app#1: 3 Assignees; added pending to ask for exactly one\n",
      stderr: "",
    });
    assert.deepEqual(t.runner.dispatched, []);
    assert.ok(t.issues.main.labels.includes("pending"));
    const [comment, ...more] = t.issues.marked("pending");
    assert.deepEqual(more, []);
    assert.match(comment.body, /Code: `STAGE_MULTIPLE_ASSIGNEES`/);
    assert.match(comment.body, /exactly one Assignee, and this Issue has 3\./);
    assert.match(comment.body, /Leave exactly one Assignee, then remove the `pending`/);
    assert.match(comment.body, /acme\/runner\/actions\/runs\/900/);
    assert.doesNotMatch(comment.body, /@|taco|other|third/);
    assert.doesNotMatch(comment.body, /looks temporary/);
  });

  it("repeats the request for one Assignee safely", async () => {
    const assignees = [
      { id: 5, login: "taco" },
      { id: 6, login: "other" },
    ];
    const t = routeDeps({ labels: ["scope"], assignees });
    await capture([...route, "--issue", "1"], t.deps);
    // While pending is present, the route writes nothing more. Each route run is a
    // new process, so none sees another's cached reads.
    const writes = t.issues.github.writes().length;
    freshReads(t.issues.github.client);
    const held = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(held.stdout, "acme/app#1: nothing to run (ineligible (pending))\n");
    assert.equal(t.issues.github.writes().length, writes);
    // A person removed pending with two Assignees left, or the label never landed.
    t.issues.main.labels = ["scope"];
    freshReads(t.issues.github.client);
    const again = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(again.code, 0);
    assert.ok(t.issues.main.labels.includes("pending"));
    assert.equal(t.issues.marked("pending").length, 1);
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("fails with the failure's note when asking for one Assignee fails", async () => {
    const assignees = [
      { id: 5, login: "taco" },
      { id: 6, login: "other" },
    ];
    const t = routeDeps({ labels: ["scope"], assignees });
    const path = "POST /repos/acme/app/issues/1/labels";
    t.issues.github.routes.set(path, failure(502));
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_WRITE_UNCONFIRMED/);
    const [comment] = t.issues.marked("pending");
    assert.match(comment.body, /Code: `GITHUB_WRITE_UNCONFIRMED`/);
  });

  it("adds pending when the route fails", async () => {
    const t = routeDeps({ labels: ["scope"] });

    t.issues.github.routes.set("GET /repos/acme/runner/actions/runs", failure(500));
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_READ_FAILED: list requested runs/);
    assert.match(result.stdout, /Added pending to acme\/app#1/);
    assert.ok(t.issues.main.labels.includes("pending"));
  });
});

describe("nibfin route --issue deletes a closed Issue's branches", () => {
  const branches = ["nibfin/issue-1", "nibfin/issue-1-cd-1"];

  function closedDelivered() {
    const t = routeDeps({ state: "closed", labels: ["scope", "shaped", "delivered"] });
    seedComment(t.issues, t.issues.main, "<!-- nibfin:delivered -->\nDelivered.");
    return { ...t, branches: fakeBranches(t.issues.github, branches) };
  }

  it("deletes them, then still dispatches the closed delivered Issue", async () => {
    const t = closedDelivered();
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.branches.deleted, branches);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "review", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    const writes = t.issues.github.writes().map((call) => call.method);
    assert.deepEqual(writes, ["DELETE", "DELETE", "POST"]);
    assert.match(result.stdout, /^acme\/app#1: deleted branch nibfin\/issue-1\n/);
  });

  it("deletes them for a closed Issue with nothing to run", async () => {
    const t = routeDeps({ state: "closed", labels: ["scope", "pause", "pending"] });
    const deleted = fakeBranches(t.issues.github, branches);
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(deleted.deleted, branches);
    assert.match(result.stdout, /nothing to run \(ineligible \(closed\)\)\n$/);
  });

  it("adds pending and dispatches nothing when a delete fails", async () => {
    const t = closedDelivered();
    const path = "/repos/acme/app/git/refs/heads/nibfin/issue-1-cd-1";
    t.issues.github.routes.set(`DELETE ${path}`, failure(422));
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_WRITE_REJECTED: delete branch acme\/app:/);
    assert.ok(t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("deletes nothing for an open Issue", async () => {
    const t = routeDeps({ labels: ["scope"] });
    const kept = fakeBranches(t.issues.github, branches);
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(kept.deleted, []);
    assert.equal(t.runner.dispatched.length, 1);
  });
});

describe("nibfin route --sha and --branch", () => {
  it("dispatches the route run of a branch's Issue", async () => {
    const t = routeDeps();
    const result = await capture([...route, "--branch", "nibfin/issue-4-cd-1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "4" },
    ]);
  });

  it("dispatches the route run of a commit's Issue", async () => {
    const t = routeDeps();
    const pulls = [pull(9, { head: "nibfin/issue-1", merged: true })];
    t.issues.github.routes.set("GET /repos/acme/app/commits/abcdef1/pulls", paged(pulls));
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
  });

  it("does nothing for a branch of no Issue", async () => {
    const t = routeDeps();
    const result = await capture([...route, "--branch", "main"], t.deps);
    assert.deepEqual(result, {
      code: 0,
      stdout: 'acme/app: {"branch":"main"} belongs to no Issue; nothing to route\n',
      stderr: "",
    });
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("fails without pending while the Issue is unknown", async () => {
    const t = routeDeps();
    t.issues.github.routes.set("GET /repos/acme/app/commits/abcdef1/pulls", failure(500));
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_READ_FAILED: /);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("adds pending to the mapped Issue when its dispatch fails", async () => {
    const t = routeDeps();
    const path =
      "/repos/acme/runner/actions/workflows/nibfin-shared-runner.yml/dispatches";
    t.issues.github.routes.set(`POST ${path}`, failure(502));
    const result = await capture([...route, "--branch", "nibfin/issue-1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_WRITE_UNCONFIRMED/);
    assert.ok(t.issues.main.labels.includes("pending"));
  });
});

describe("nibfin route input", () => {
  it("reads the target, the token and the execution run", () => {
    const input = readRouteInput(["--repo", "acme/app", "--sha", "abcdef1"], env);
    assert.deepEqual(input, {
      repo: { owner: "acme", repo: "app" },
      target: { sha: "abcdef1" },
      token: fakeToken,
      runRepo: { owner: "acme", repo: "runner" },
      runId: 900,
    });
    const noRun = { ...env, NIBFIN_RUN_ID: undefined };
    assert.equal(
      readRouteInput(["--repo", "a/b", "--issue", "2"], noRun).runId,
      undefined,
    );
  });

  for (const [name, args, change, message] of [
    ["an unknown option", ["--force", "1"], {}, '"--force" is not a known option'],
    ["a missing value", ["--repo"], {}, "--repo needs a value"],
    ["an option as value", ["--repo", "--issue"], {}, "--repo needs a value"],
    [
      "a repeated option",
      ["--repo", "a/b", "--repo", "a/c", "--issue", "1"],
      {},
      "--repo is given more than once",
    ],
    [
      "no target",
      ["--repo", "a/b"],
      {},
      "exactly one of --issue, --sha and --branch is needed",
    ],
    [
      "two targets",
      ["--repo", "a/b", "--issue", "1", "--branch", "x"],
      {},
      "exactly one of --issue, --sha and --branch is needed",
    ],
    [
      "a bad Issue",
      ["--repo", "a/b", "--issue", "x"],
      {},
      "--issue must be a positive integer",
    ],
    ["a bad SHA", ["--repo", "a/b", "--sha", "main"], {}, "--sha must be a commit SHA"],
    ["no repository", ["--issue", "1"], {}, "--repo is missing"],
    [
      "no token",
      ["--repo", "a/b", "--issue", "1"],
      { NIBFIN_GITHUB_TOKEN: undefined },
      "NIBFIN_GITHUB_TOKEN is missing",
    ],
    [
      "no execution repository",
      ["--repo", "a/b", "--issue", "1"],
      { NIBFIN_RUN_REPO: undefined },
      "NIBFIN_RUN_REPO is missing",
    ],
  ] as const) {
    it(`rejects ${name} without a GitHub call`, async () => {
      const t = routeDeps();
      t.deps.env = { ...env, ...change };
      const result = await capture(["route", ...args], t.deps);
      assert.deepEqual(result, {
        code: 1,
        stdout: "",
        stderr: `nibfin: STAGE_INPUT_INVALID: ${message}\n`,
      });
      assert.deepEqual(t.tokens, []);
    });
  }

  it("fails when the token's account cannot be read", async () => {
    const t = routeDeps();
    t.deps.connect = () =>
      Promise.reject(new GitHubError("GITHUB_READ_FAILED", "read user", new Error()));
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_READ_FAILED: read user/);
  });
});
