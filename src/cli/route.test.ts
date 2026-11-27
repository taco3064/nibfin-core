import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, fakeToken, type Handler, paged } from "../github/fake-github.test.ts";
import { pull } from "../github/fixtures.test.ts";
import { freshReads, GitHubError } from "../github/index.ts";
import { requestPerson, StageError } from "../stages/index.ts";
import { fakeBranches } from "../route/fake-branches.test.ts";
import { fakeRunner, selfHostedRunner } from "../route/fake-runner.test.ts";
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
      scope: () => Promise.reject(new Error("no stage runs in a route run")),
      shape: () => Promise.reject(new Error("no stage runs in a route run")),
      deliver: () => Promise.reject(new Error("no stage runs in a route run")),
      review: () => Promise.reject(new Error("no stage runs in a route run")),
      finish: () => Promise.reject(new Error("no stage runs in a route run")),
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
    const [chosen, dispatched] = result.stdout.split("\n");
    assert.equal(chosen, "acme/app#1: Assignee 5 has an online runner");
    assert.match(dispatched, /^Dispatched Nibfin · acme\/app#1 · shape: https:/);
    assert.ok(!result.stdout.includes(fakeToken));
  });

  it("dispatches the Scope stage for a request", async () => {
    const t = routeDeps({ labels: ["request"] });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "scope", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    assert.match(result.stdout, /Dispatched Nibfin · acme\/app#1 · scope: https:/);
  });

  for (const labels of [
    ["request", "pending"],
    ["scope", "pending"],
  ]) {
    it(`advises for ${labels.join(" and ")} without a cause`, async () => {
      const t = routeDeps({ labels });
      const result = await capture([...route, "--issue", "1"], t.deps);
      assert.equal(result.code, 0);
      assert.equal(
        result.stdout,
        "acme/app#1: repair (new)\nacme/app#1: repair: not classified, advice\n",
      );
      assert.deepEqual(t.runner.dispatched, []);
      assert.ok(t.issues.main.labels.includes("pending"));
      const [record] = t.issues.marked("repair");
      assert.match(record.body, /status=needs-person action=advice handled= -->/);
      // A later wake writes nothing more for that stop.
      const writes = t.issues.github.writes().length;
      const again = await capture([...route, "--issue", "1"], t.deps);
      assert.equal(again.code, 0);
      assert.equal(t.issues.github.writes().length, writes);
    });
  }

  it("writes nothing when no runner has the Assignee's label", async () => {
    const t = routeDeps({ labels: ["scope"] });
    t.runner.runners = [];
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, []);
    assert.deepEqual(t.issues.github.writes(), []);
    assert.equal(
      result.stdout,
      "acme/app#1: no runner of the execution repository has the label " +
        "nibfin-<id> of any Assignee (5); an ordinary assignment, nothing dispatched\n",
    );
  });

  it("dispatches to the second of two Assignees with the online runner", async () => {
    const assignees = [
      { id: 6, login: "other" },
      { id: 5, login: "taco" },
    ];
    const t = routeDeps({ labels: ["scope", "shaped"], assignees });
    seedComment(t.issues, t.issues.main, "<!-- nibfin:consent-6 -->\nAsked.");
    t.runner.runners = [
      selfHostedRunner(1, ["nibfin-6"], { status: "offline" }),
      selfHostedRunner(2, ["nibfin-5"]),
    ];
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "deliver", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    assert.match(result.stdout, /^acme\/app#1: Assignee 5 has an online runner\n/);
    assert.ok(!t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.issues.marked("pending"), []);
    assert.deepEqual(
      t.issues.github.writes().map((call) => call.method),
      ["POST"],
    );
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

  it("pauses for a collaborator Assignee, then dispatches without pause", async () => {
    const t = routeDeps({ labels: ["scope"], assignees: [{ id: 7, login: "ann" }] });
    t.runner.runners = [selfHostedRunner(1, ["nibfin-7"])];
    const first = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(first.code, 0);
    assert.deepEqual(t.runner.dispatched, []);
    assert.ok(t.issues.main.labels.includes("pause"));
    const [comment] = t.issues.marked("consent-7");
    assert.match(comment.body, /^<!-- nibfin:consent-7 -->\n@ann, /);
    assert.match(first.stdout, /added pause for the consent of Assignee\(s\) 7/);
    t.issues.main.labels.splice(t.issues.main.labels.indexOf("pause"), 1);
    freshReads(t.issues.github.client);
    const second = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(second.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "shape", repo: "acme/app", issue: "1", reason: "", assignee: "7" },
    ]);
    assert.equal(t.issues.marked("consent-7").length, 1);
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
      { stage: "finish", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
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

  /**
   * Commit abcdef1: GitHub associates `associated` with it; `merged` also merged to
   * it (the base did not move).
   */
  function commitOf(t: ReturnType<typeof routeDeps>, associated: number, merged = 0) {
    const { routes } = t.issues.github;
    const pulls = [pull(9, { head: `nibfin/issue-${associated}`, merged: true })];
    routes.set("GET /repos/acme/app/commits/abcdef1/pulls", paged(pulls));
    routes.set("GET /repos/acme/app/git/commits/abcdef1", {
      data: { sha: "abcdef1", committer: { date: "2026-11-26T19:34:27Z" } },
    });
    const listed = [10, 9].map((number) => {
      const issue = number === 9 ? associated : merged;
      const options = {
        head: `nibfin/issue-${issue}`,
        merged: true,
        mergeSha: "abcdef1",
      };
      return { ...pull(number, options), updated_at: "2026-11-26T19:35:00Z" };
    });
    routes.set(
      "GET /repos/acme/app/pulls",
      paged(merged === 0 ? listed.slice(1) : listed),
    );
  }

  it("dispatches the route run of a commit's Issue", async () => {
    const t = routeDeps();
    commitOf(t, 1);
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
  });

  it("dispatches one route run per Issue merged to the commit", async () => {
    const t = routeDeps();
    commitOf(t, 1, 2);
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
      { stage: "route", repo: "acme/app", issue: "2" },
    ]);
  });

  it("still dispatches the other Issues when one dispatch fails", async () => {
    const t = routeDeps();
    commitOf(t, 1, 2);
    const path =
      "/repos/acme/runner/actions/workflows/nibfin-shared-runner.yml/dispatches";
    const dispatch = t.issues.github.routes.get(`POST ${path}`) as Handler;
    t.issues.github.routes.set(`POST ${path}`, (request) => {
      const { inputs } = request.body as { inputs: Record<string, string> };
      return inputs.issue === "1" ? failure(502) : dispatch(request);
    });
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_WRITE_UNCONFIRMED/);
    assert.ok(t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "2" },
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

  it("adds pending to the commit's Issue when the waiter walk fails", async () => {
    const t = routeDeps();
    commitOf(t, 1);
    t.issues.github.routes.set("GET /repos/acme/app/actions/runs", failure(500));
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_READ_FAILED/);
    assert.ok(t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
  });

  it("fails without pending when the walk of a commit of no Issue fails", async () => {
    const t = routeDeps();
    t.issues.github.routes.set("GET /repos/acme/app/commits/abcdef1/pulls", paged([]));
    t.issues.github.routes.set("GET /repos/acme/app/git/commits/abcdef1", {
      data: { sha: "abcdef1", committer: { date: "2026-11-26T19:34:27Z" } },
    });
    t.issues.github.routes.set("GET /repos/acme/app/pulls", paged([]));
    t.issues.github.routes.set("GET /repos/acme/app/actions/runs", failure(500));
    const result = await capture([...route, "--sha", "abcdef1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GITHUB_READ_FAILED/);
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

describe("nibfin route --issue runs the repair stage", () => {
  const instant = {
    now: () => Date.parse("2026-11-27T12:00:00Z"),
    sleep: () => Promise.resolve(),
    jobStart: Date.parse("2026-11-27T12:00:00Z"),
  };

  /** An Issue with `scope` that stopped on `error`, with the test clock. */
  async function stopped(error: unknown, overrides: Partial<FakeIssue> = {}) {
    const t = routeDeps({ labels: ["scope"], ...overrides });
    t.deps.clock = instant;
    const issue = { owner: "acme", repo: "app", number: 1 };
    const url = "https://github.com/acme/runner/actions/runs/800";
    await requestPerson(t.issues.github.client, issue, error, url);
    return t;
  }

  it("removes pending from a temporary stop and dispatches once more", async () => {
    const t = await stopped(new StageError("STAGE_GIT_FAILED", "git failed"));
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.ok(!t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, [
      { stage: "shape", repo: "acme/app", issue: "1", reason: "", assignee: "5" },
    ]);
    const lines = result.stdout.split("\n");
    assert.equal(lines[0], "acme/app#1: repair (new)");
    assert.equal(lines[1], "acme/app#1: repair: external temporary problem, retry");
    assert.match(result.stdout, /Dispatched Nibfin · acme\/app#1 · shape: https:/);
    assert.match(t.issues.marked("repair")[0].body, /status=repairing action=retry/);
  });

  it("logs nothing to run when the released Issue has nothing to dispatch", async () => {
    const t = await stopped(new StageError("STAGE_GIT_FAILED", "x"), { assignees: [] });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 0);
    assert.ok(!t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, []);
    assert.match(
      result.stdout,
      /acme\/app#1: nothing to run \(ineligible \(no-assignee\)\)\n$/,
    );
  });

  it("keeps pending and names the repair stage when it fails (R4.50)", async () => {
    const t = await stopped(new StageError("STAGE_GIT_FAILED", "x"));
    t.issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/pending", {
      data: [{ name: "pending" }],
    });
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_WRITE_UNCONFIRMED: remove pending/);
    assert.match(result.stdout, /Added pending to acme\/app#1/);
    assert.ok(t.issues.main.labels.includes("pending"));
    const [pending] = t.issues.marked("pending");
    assert.match(
      pending.body,
      /- Code: `GITHUB_WRITE_UNCONFIRMED`\n- Run: .*\n- Stage: `repair`\n/,
    );
    assert.deepEqual(t.runner.dispatched, []);
    // The repair stage does not start again for that stop.
    freshReads(t.issues.github.client);
    const writes = t.issues.github.writes().length;
    const again = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "acme/app#1: nothing to run (ineligible (pending))\n");
    assert.equal(t.issues.github.writes().length, writes);
  });

  it("leaves a paused Issue alone", async () => {
    const t = await stopped(new StageError("STAGE_GIT_FAILED", "x"));
    t.issues.main.labels.push("pause");
    freshReads(t.issues.github.client);
    const result = await capture([...route, "--issue", "1"], t.deps);
    assert.equal(result.stdout, "acme/app#1: nothing to run (ineligible (paused))\n");
    assert.deepEqual(t.issues.marked("repair"), []);
  });
});
