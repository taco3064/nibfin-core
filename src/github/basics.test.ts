import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectAs, connectClient, createClient, readActor, readUser } from "./client.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, rejection } from "./fake-github.test.ts";
import { nibfinLabels } from "./labels.ts";
import {
  isNibfinWorkflow,
  nibfinRunTitle,
  nibfinWorkflowPrefix,
} from "./nibfin-workflows.ts";
import { formatIssue, labelNames, parseRepositoryUrl } from "./repo.ts";
import { commitStatusState, runState } from "./run-state.ts";

describe("createClient", () => {
  it("authenticates with the token and carries a frozen copy of the actor", async () => {
    const actor = { id: 7, login: "bot" };
    const client = createClient("secret-token", actor);
    actor.id = 8;
    assert.deepEqual(client.actor, { id: 7, login: "bot" });
    assert.ok(Object.isFrozen(client.actor));
    let headers = new Headers();
    const original = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      headers = new Headers(init?.headers);
      return Promise.resolve(Response.json({}));
    };
    try {
      await client.request("GET /rate_limit");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(headers.get("authorization"), "token secret-token");
    assert.match(headers.get("user-agent") ?? "", /^nibfin-core/);
  });
});

describe("readActor and connectClient", () => {
  it("reads the token's own account with GET /user", async () => {
    const github = fakeGitHub({ "GET /user": { data: { id: 7, login: "owner" } } });
    assert.deepEqual(await readActor(github.client), { id: 7, login: "owner" });
  });

  it("fails as a read when GET /user fails", async () => {
    const github = fakeGitHub({ "GET /user": failure(403) });
    const error = await rejection(readActor(github.client));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });

  it("connects a client that writes as the token's account", async () => {
    const seen: string[] = [];
    const fetch = (input: string | URL) => {
      seen.push(new URL(input).pathname);
      return Promise.resolve(Response.json({ id: 9, login: "taco" }));
    };
    const client = await connectClient("secret-token", { request: { fetch } });
    assert.deepEqual(client.actor, { id: 9, login: "taco" });
    assert.deepEqual(seen, ["/user"]);
  });
});

describe("readUser and connectAs", () => {
  const bot = "GET /users/github-actions[bot]";

  it("reads an account by login", async () => {
    const github = fakeGitHub({ [bot]: { data: { id: 41898282, login: "x[bot]" } } });
    const user = await readUser(github.client, "github-actions[bot]");
    assert.deepEqual(user, { id: 41898282, login: "x[bot]" });
  });

  it("fails as a read when the account cannot be read", async () => {
    const error = await rejection(readUser(fakeGitHub().client, "ghost"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });

  it("connects a client that writes as the account it names", async () => {
    const seen: string[] = [];
    const fetch = (input: string | URL) => {
      seen.push(new URL(input).pathname);
      return Promise.resolve(
        Response.json({ id: 41898282, login: "github-actions[bot]" }),
      );
    };
    const options = { request: { fetch } };
    const client = await connectAs("job-token", "github-actions[bot]", options);
    assert.deepEqual(client.actor, { id: 41898282, login: "github-actions[bot]" });
    assert.deepEqual(seen, ["/users/github-actions%5Bbot%5D"]);
  });
});

describe("Nibfin workflows", () => {
  it("recognizes names by the single prefix", () => {
    assert.equal(nibfinWorkflowPrefix, "Nibfin ·");
    assert.equal(isNibfinWorkflow("Nibfin · events"), true);
    assert.equal(isNibfinWorkflow("CI"), false);
    assert.equal(isNibfinWorkflow("nibfin · events"), false);
    assert.equal(isNibfinWorkflow(null), false);
    assert.equal(isNibfinWorkflow(undefined), false);
    const title = nibfinRunTitle({ owner: "acme", repo: "app" }, 3, "route");
    assert.equal(title, "Nibfin · acme/app#3 · route");
    assert.equal(isNibfinWorkflow(title), true);
  });

  it("names the labels Nibfin uses", () => {
    assert.deepEqual(nibfinLabels, {
      request: "request",
      scope: "scope",
      shaped: "shaped",
      delivered: "delivered",
      pause: "pause",
      pending: "pending",
    });
  });
});

describe("repository helpers", () => {
  it("formats an Issue reference", () => {
    assert.equal(formatIssue({ owner: "acme", repo: "app", number: 3 }), "acme/app#3");
  });

  it("parses a repository API URL, including GitHub Enterprise paths", () => {
    assert.deepEqual(parseRepositoryUrl("https://api.github.com/repos/acme/app"), {
      owner: "acme",
      repo: "app",
    });
    assert.deepEqual(parseRepositoryUrl("https://ghe.example/api/v3/repos/a%20b/c.d"), {
      owner: "a b",
      repo: "c.d",
    });
  });

  it("rejects URLs that are not repository API URLs", () => {
    for (const url of ["https://api.github.com/acme/app", "https://api.github.com/app"]) {
      assert.throws(() => parseRepositoryUrl(url), TypeError);
    }
  });

  it("reads label names from objects and strings", () => {
    assert.deepEqual(labelNames(["a", { name: "b" }, {}]), ["a", "b"]);
  });
});

describe("run states", () => {
  it("maps check run and workflow run conclusions", () => {
    for (const conclusion of ["success", "neutral", "skipped"]) {
      assert.equal(runState("completed", conclusion), "success");
    }
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "startup_failure",
      "stale",
    ]) {
      assert.equal(runState("completed", conclusion), "failed");
    }
    assert.equal(runState("completed", "action_required"), "pending");
    assert.equal(runState("completed", "something_new"), "pending");
    assert.equal(runState("completed", null), "pending");
    assert.equal(runState("completed", undefined), "pending");
    assert.equal(runState("in_progress", null), "pending");
    assert.equal(runState("queued", "success"), "pending");
    assert.equal(runState(null, null), "pending");
  });

  it("maps commit status states", () => {
    assert.equal(commitStatusState("success"), "success");
    assert.equal(commitStatusState("error"), "failed");
    assert.equal(commitStatusState("failure"), "failed");
    assert.equal(commitStatusState("pending"), "pending");
  });
});
