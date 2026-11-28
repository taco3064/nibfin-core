import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { failure, paged, sequence } from "../github/fake-github.test.ts";
import type { ActingClient } from "../github/index.ts";
import { dispatchPath, fakeRunner } from "../route/fake-runner.test.ts";
import { fakeIssue, fakeIssues } from "../stages/fake-job.test.ts";
import { readPendingCause, requestPerson } from "../stages/pending.ts";
import { StageError } from "../stages/errors.ts";
import { type ActionDeps, defaultActionDeps, runAction } from "./run.ts";

const env = {
  INPUT_COMMAND: "job-failed",
  INPUT_TOKEN: "secret-token",
  INPUT_REPO: "acme/app",
  INPUT_ISSUE: "1",
  INPUT_STAGE: "deliver",
  GITHUB_REPOSITORY: "acme/runner",
  GITHUB_RUN_ID: "900",
};
const url = "https://github.com/acme/runner/actions/runs/900";

async function capture(deps: ActionDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAction(
    {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
    deps,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Deps whose connect hands out `client` and logs one line through the Action's log. */
function depsFor(
  client: ActingClient,
  overrides: Record<string, string | undefined> = {},
  event = "{}",
) {
  const tokens: string[] = [];
  const deps: ActionDeps = {
    env: { ...env, ...overrides },
    connect: (token, log) => {
      tokens.push(token);
      log("GET /user");
      return Promise.resolve(client);
    },
    connectJob: (token) => {
      tokens.push(token);
      return Promise.resolve(client);
    },
    readFile: () => event,
    age: () => ({
      check: () => Promise.resolve(),
      encrypt: () => Promise.resolve("CIPHER\n"),
    }),
  };
  return { deps, tokens };
}

describe("runAction job-failed", () => {
  it("adds pending with JOB_FAILED and exits 0", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    const { deps, tokens } = depsFor(issues.github.client);
    const result = await capture(deps);
    assert.deepEqual(result, {
      code: 0,
      stdout: "GET /user\nAdded pending to acme/app#1\n",
      stderr: "",
    });
    assert.deepEqual(tokens, ["secret-token"]);
    const [comment] = issues.marked("pending");
    const cause = readPendingCause(comment.body);
    assert.equal(cause.code, "JOB_FAILED");
    assert.equal(cause.run, url);
    assert.ok(comment.body.includes("The `deliver` Job failed"));
    assert.ok(issues.main.labels.includes("pending"));
  });

  it("leaves a standing stop as it is and exits 0", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    const error = new StageError("STAGE_GIT_FAILED", "git failed");
    await requestPerson(issues.github.client, issues.main, error, url);
    const { deps } = depsFor(issues.github.client);
    const result = await capture(deps);
    assert.equal(result.code, 0);
    assert.ok(
      result.stdout.endsWith("acme/app#1: Nibfin's stop stands; left as it is\n"),
    );
    assert.equal(
      readPendingCause(issues.marked("pending")[0].body).code,
      "STAGE_GIT_FAILED",
    );
  });

  it("exits 1 with the failure when GitHub cannot be written", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    issues.github.routes.set(
      "POST /repos/acme/app/issues/1/comments",
      sequence(failure(500), failure(500), failure(500), failure(500)),
    );
    const { deps } = depsFor(issues.github.client);
    const result = await capture(deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_\w+: /);
    assert.ok(!result.stderr.includes("secret-token"));
  });

  it("exits 1 on invalid input before it connects", async () => {
    const issues = fakeIssues(fakeIssue());
    const { deps, tokens } = depsFor(issues.github.client, { INPUT_ISSUE: "x" });
    const result = await capture(deps);
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "nibfin: STAGE_INPUT_INVALID: INPUT_ISSUE must be a positive integer\n",
    });
    assert.deepEqual(tokens, []);
  });

  it("exits 1 on an unknown command", async () => {
    const issues = fakeIssues(fakeIssue());
    const { deps } = depsFor(issues.github.client, { INPUT_COMMAND: "deploy" });
    const result = await capture(deps);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "nibfin: STAGE_INPUT_INVALID: INPUT_COMMAND must be one of job-failed, " +
        "runner-request, wake\n",
    );
  });
});

describe("runAction runner-request", () => {
  const requestEnv = {
    INPUT_COMMAND: "runner-request",
    "INPUT_JOB-TOKEN": "secret-job-token",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/runner/event.json",
    GITHUB_REPOSITORY: "acme/app",
  };
  const event = JSON.stringify({
    action: "opened",
    issue: {
      number: 1,
      title: "Nibfin runner request",
      body: "<!-- nibfin:runner-request -->\nssh-key-id: 5\n",
      user: { login: "ann", type: "User" },
    },
  });

  function requestWorld(token: string | null = "secret-token") {
    const issues = fakeIssues(fakeIssue({ labels: [] }));
    const { github } = issues;
    github.routes.set("GET /repos/acme/app/collaborators/ann/permission", {
      data: { permission: "write" },
    });
    github.routes.set("GET /users/ann/keys", paged([{ id: 5, key: "ssh-rsa AAAA" }]));
    github.routes.set("POST /repos/acme/app/actions/runners/registration-token", {
      status: 201,
      data: { token: "REG", expires_at: "2026-11-28T01:00:00Z" },
    });
    github.routes.set("PATCH /repos/acme/app/issues/1", (request) => {
      issues.main.state = (request.body as { state: "closed" }).state;
      return { data: { number: 1, state: issues.main.state } };
    });
    const overrides = { ...requestEnv, INPUT_TOKEN: token ?? undefined };
    return { issues, ...depsFor(github.client, overrides, event) };
  }

  it("answers the request with both tokens and exits 0", async () => {
    const world = requestWorld();
    const result = await capture(world.deps);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.includes("::add-mask::REG\n"));
    assert.deepEqual(world.tokens, ["secret-job-token", "secret-token"]);
    const [answer] = world.issues.marked("runner-registration");
    assert.ok(answer.body.includes("\nCIPHER\n"));
  });

  it("answers as failed and exits 1 when the Nibfin token is missing", async () => {
    const world = requestWorld(null);
    const result = await capture(world.deps);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "nibfin: STAGE_INPUT_INVALID: INPUT_TOKEN is missing\n");
    assert.equal(world.issues.marked("runner-request-refused").length, 1);
    assert.equal(world.issues.main.state, "closed");
  });

  it("exits 1 on invalid input before it connects", async () => {
    const world = requestWorld();
    const env = { ...world.deps.env, "INPUT_JOB-TOKEN": undefined };
    const result = await capture({ ...world.deps, env });
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "nibfin: STAGE_INPUT_INVALID: INPUT_JOB-TOKEN is missing\n",
    });
    assert.deepEqual(world.tokens, []);
  });
});

describe("runAction wake", () => {
  const wakeEnv = {
    INPUT_COMMAND: "wake",
    "INPUT_EXECUTION-REPO": "acme/runner",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/runner/event.json",
    GITHUB_REPOSITORY: "acme/app",
  };
  const opened = JSON.stringify({
    action: "opened",
    sender: { login: "ann" },
    issue: { number: 1, labels: [{ name: "scope" }] },
  });

  function wakeWorld(token: string | undefined = "secret-token", event = opened) {
    const issues = fakeIssues(fakeIssue());
    const { github } = issues;
    github.routes.set("GET /repos/acme/app/collaborators/ann/permission", {
      data: { permission: "write" },
    });
    const runner = fakeRunner(github);
    const overrides = { ...wakeEnv, INPUT_TOKEN: token };
    return { issues, runner, ...depsFor(github.client, overrides, event) };
  }

  it("dispatches the route run of the event's Issue and exits 0", async () => {
    const world = wakeWorld();
    const result = await capture(world.deps);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.startsWith("GET /user\nDispatched Nibfin · acme/app#1 · "));
    assert.deepEqual(world.tokens, ["secret-token"]);
    assert.deepEqual(world.runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
  });

  it("skips an event without a token and without connecting", async () => {
    const world = wakeWorld(undefined, JSON.stringify({}));
    const result = await capture({
      ...world.deps,
      env: { ...world.deps.env, GITHUB_EVENT_NAME: "pull_request_review" },
    });
    assert.deepEqual(result, {
      code: 0,
      stdout: "A review on a pull request that is not Nibfin's; not routed\n",
      stderr: "",
    });
    assert.deepEqual(world.tokens, []);
  });

  it("exits 1 when an event wakes an Issue but the token is missing", async () => {
    const world = wakeWorld("");
    const result = await capture(world.deps);
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "nibfin: STAGE_INPUT_INVALID: INPUT_TOKEN is missing\n",
    });
  });

  it("exits 1 without pending when the execution repository is not set", async () => {
    const world = wakeWorld();
    const env = { ...world.deps.env, "INPUT_EXECUTION-REPO": "" };
    const result = await capture({ ...world.deps, env });
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr:
        "nibfin: STAGE_INPUT_INVALID: The variable NIBFIN_EXECUTION_REPO is not set " +
        "(input execution-repo)\n",
    });
    assert.deepEqual(world.tokens, []);
    assert.deepEqual(world.issues.marked("pending"), []);
  });

  it("exits 1 with the failure after asking a person", async () => {
    const world = wakeWorld();
    world.issues.github.routes.set(`POST ${dispatchPath}`, failure(422));
    const result = await capture(world.deps);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.endsWith("Added pending to acme/app#1\n"));
    assert.match(result.stderr, /^nibfin: GITHUB_WRITE_REJECTED: /);
    assert.ok(!result.stderr.includes("secret-token"));
  });
});

describe("defaultActionDeps", () => {
  it("reads the process environment", () => {
    assert.equal(defaultActionDeps.env, process.env);
  });

  it("reads a file as UTF-8 text", () => {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const text = defaultActionDeps.readFile(path);
    assert.equal((JSON.parse(text) as { name: string }).name, "nibfin-core");
  });

  it("connects with Core's client, which reads the token's user", async () => {
    const fetches: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input) => {
      fetches.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(Response.json({ id: 9, login: "nibfin" }));
    };
    try {
      const client = await defaultActionDeps.connect("t", () => {});
      assert.deepEqual(client.actor, { id: 9, login: "nibfin" });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(fetches, ["https://api.github.com/user"]);
  });

  it("connects the job token's client as github-actions[bot]", async () => {
    const fetches: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input) => {
      fetches.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(
        Response.json({ id: 41898282, login: "github-actions[bot]" }),
      );
    };
    try {
      const client = await defaultActionDeps.connectJob("t", () => {});
      assert.deepEqual(client.actor, { id: 41898282, login: "github-actions[bot]" });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(fetches, ["https://api.github.com/users/github-actions%5Bbot%5D"]);
  });

  it("runs age from PATH", async () => {
    const age = defaultActionDeps.age({ PATH: "/nibfin-no-such-directory" });
    await assert.rejects(age.check(), /^AgeError: age --version failed/);
  });
});
