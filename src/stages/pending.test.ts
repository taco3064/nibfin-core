import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentError } from "../agent/index.ts";
import { ConfigError } from "../config/index.ts";
import { failure, rejection, sequence } from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import { NoProgressError, StageError, type StageErrorCode } from "./errors.ts";
import { fakeIssue, fakeIssues } from "./fake-job.test.ts";
import {
  codeOf,
  pendingBody,
  pendingCommentKey,
  requestPerson,
  runUrl,
  temporaryCodes,
} from "./pending.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const url = "https://github.com/acme/runner/actions/runs/900";
const temporaryNote = /This looks temporary \(network, GitHub or a single agent run\)/;

const stageCodes: StageErrorCode[] = [
  "STAGE_INPUT_INVALID",
  "STAGE_RESULT_INVALID",
  "STAGE_BLOCKED",
  "STAGE_WORKSPACE_MODIFIED",
  "STAGE_GIT_FAILED",
  "STAGE_PUSH_REJECTED",
  "STAGE_HOST_MEMORY_LOW",
  "STAGE_NO_PROGRESS",
];

/** One failure of every code a stage, route or dispatch can end with. */
const failures: Error[] = [
  ...stageCodes.map((code) => new StageError(code, `failed with ${code}`)),
  new GitHubError("GITHUB_READ_FAILED", "read acme/app#1", new Error("x")),
  new GitHubError("GITHUB_WRITE_UNCONFIRMED", "write", new Error("x")),
  new GitHubError("GITHUB_WRITE_REJECTED", "write", new Error("x")),
  new AgentError("AGENT_RUN_FAILED", "the agent failed", {}),
  new AgentError("AGENT_LOGIN_REQUIRED", "log in", {}),
  new AgentError("AGENT_USAGE_LIMIT", "usage limit", { usageLimitReset: "18:00" }),
  new AgentError("AGENT_CONFIG_GENERATION_FAILED", "rulesync failed", {}),
  new AgentError("AGENT_CONFIG_INVALID", "bad", {}),
  new ConfigError("CONFIG_INVALID", "bad .nibfin.json"),
  new ConfigError("CONFIG_SKILL_PATH_INVALID", "bad skill"),
  new ConfigError("TOOL_INSTALL_FAILED", "no node"),
];

describe("requestPerson", () => {
  for (const error of failures) {
    const code = codeOf(error)!;
    it(`adds pending with a comment for ${code}`, async () => {
      const issues = fakeIssues(fakeIssue({ labels: ["scope", "shaped"] }));
      assert.equal(await requestPerson(issues.github.client, issue, error, url), true);
      assert.ok(issues.main.labels.includes("pending"));
      const [comment] = issues.marked(pendingCommentKey);
      assert.ok(comment.body.includes(`- Code: \`${code}\``));
      assert.ok(comment.body.includes(error.message));
      assert.ok(comment.body.includes(`- Run: ${url}`));
      assert.match(comment.body, /Remove the `pending` label to continue\.$/);
      assert.equal(temporaryNote.test(comment.body), temporaryCodes.has(code));
    });
  }

  it("marks exactly the documented codes temporary", () => {
    assert.deepEqual(
      [...temporaryCodes],
      [
        "GITHUB_READ_FAILED",
        "GITHUB_WRITE_UNCONFIRMED",
        "STAGE_GIT_FAILED",
        "TOOL_INSTALL_FAILED",
        "AGENT_RUN_FAILED",
        "STAGE_RESULT_INVALID",
      ],
    );
  });

  it("writes nothing for STAGE_WRITER_ACTIVE, which is a wait", async () => {
    const issues = fakeIssues(fakeIssue());
    const error = new StageError("STAGE_WRITER_ACTIVE", "another Writer runs");
    assert.equal(await requestPerson(issues.github.client, issue, error, url), false);
    assert.deepEqual(issues.github.writes(), []);
  });

  it("marks a write rejected by a rate limit temporary", () => {
    const limited = Object.assign(new Error("You have exceeded a secondary rate limit"), {
      status: 403,
      response: { status: 403, headers: {}, data: {} },
    });
    const error = new GitHubError("GITHUB_WRITE_REJECTED", "write x", limited);
    const body = pendingBody(error, url);
    assert.match(
      body,
      /write x: write rejected \(HTTP 403, rate limited \(secondary\)\)/,
    );
    assert.match(body, temporaryNote);
    const plain = new GitHubError("GITHUB_WRITE_REJECTED", "write x", {
      status: 403,
      response: { status: 403, headers: {}, data: {} },
    });
    assert.doesNotMatch(pendingBody(plain, url), temporaryNote);
  });

  it("marks a no-progress stop temporary only when it says so", () => {
    const wait = pendingBody(new NoProgressError("mergeability", true), url);
    assert.match(wait, temporaryNote);
    assert.ok(wait.includes("- Code: `STAGE_NO_PROGRESS`"));
    const stuck = pendingBody(new NoProgressError("no head", false), url);
    assert.doesNotMatch(stuck, temporaryNote);
  });

  it("describes uncoded errors, thrown values and an unknown run", () => {
    const body = pendingBody(new Error("boom"), undefined);
    assert.ok(body.includes("- Code: `none`\n- Run: unknown"));
    assert.ok(pendingBody("odd", url).includes("\nodd\n"));
    assert.equal(codeOf({ code: 7 }), undefined);
    assert.equal(codeOf(null), undefined);
  });

  it("updates the one pending comment on a repeated failure", async () => {
    const issues = fakeIssues(fakeIssue());
    const { client } = issues.github;
    await requestPerson(client, issue, new Error("first"), url);
    await requestPerson(client, issue, new Error("second"), url);
    const comments = issues.marked(pendingCommentKey);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /second/);
  });

  it("fails unconfirmed when the read-back labels lack pending", async () => {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("POST /repos/acme/app/issues/1/labels", { data: [] });
    const error = await rejection(
      requestPerson(issues.github.client, issue, new Error("x"), url),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
  });

  it("writes a rejected comment again without the message", async () => {
    const issues = fakeIssues(fakeIssue());
    const route = "POST /repos/acme/app/issues/1/comments";
    issues.github.routes.set(
      route,
      sequence(failure(422), issues.github.routes.get(route)!),
    );
    const error = new StageError("STAGE_GIT_FAILED", "a very long message");
    assert.equal(await requestPerson(issues.github.client, issue, error, url), true);
    const fence = "```text\na very long message\n```";
    const full = pendingBody(error, url);
    assert.ok(full.includes(fence));
    const [comment] = issues.marked(pendingCommentKey);
    const short = full.replace(fence, "The full message is in the run log.");
    assert.ok(comment.body.endsWith(`\n${short}`));
    assert.doesNotMatch(comment.body, /a very long message|```/);
    assert.match(comment.body, temporaryNote);
    assert.ok(issues.main.labels.includes("pending"));
    const posts = issues.github.writes().filter((call) => route.endsWith(call.path));
    assert.equal(posts.length, 2);
  });

  it("fails when GitHub rejects the comment without the message too", async () => {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("POST /repos/acme/app/issues/1/comments", failure(403));
    const error = await rejection(
      requestPerson(issues.github.client, issue, new Error("x"), url),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_REJECTED");
    assert.equal(issues.github.writes().length, 2);
    assert.ok(!issues.main.labels.includes("pending"));
  });

  it("does not write again after any other comment failure", async () => {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("POST /repos/acme/app/issues/1/comments", failure(500));
    const error = await rejection(
      requestPerson(issues.github.client, issue, new Error("x"), url),
    );
    assert.ok(error instanceof GitHubError);
    assert.notEqual(error.code, "GITHUB_WRITE_REJECTED");
    assert.ok(!issues.main.labels.includes("pending"));
  });
});

describe("pendingBody for a usage limit", () => {
  const reset = "2026-11-24T18:00:00Z";
  const note =
    "The provider's usage limit was reached; it resets at `2026-11-24T18:00:00Z`. " +
    "Remove the `pending` label after that time to continue.";

  it("says when the limit resets and is not temporary", () => {
    const error = new AgentError("AGENT_USAGE_LIMIT", "stopped", {
      usageLimitReset: reset,
    });
    for (const body of [pendingBody(error, url), pendingBody(error, url, false)]) {
      assert.ok(body.includes("- Code: `AGENT_USAGE_LIMIT`"));
      assert.ok(body.includes(`${note}\n\nRemove the \`pending\` label to continue.`));
      assert.doesNotMatch(body, temporaryNote);
    }
    assert.doesNotMatch(pendingBody(error, url, false), /limit message/);
  });

  it("says the reset time is unknown when the CLI did not report it", () => {
    const unknown =
      "The provider's usage limit was reached; the CLI did not report when it " +
      "resets. Remove the `pending` label after the limit resets to continue.";
    const agent = new AgentError("AGENT_USAGE_LIMIT", "stopped", {});
    const other = Object.assign(new Error("stopped"), { code: "AGENT_USAGE_LIMIT" });
    for (const error of [agent, other]) {
      const body = pendingBody(error, url);
      assert.ok(body.includes(unknown));
      assert.doesNotMatch(body, temporaryNote);
    }
  });

  it("leaves other failures without the note", () => {
    const body = pendingBody(new AgentError("AGENT_RUN_FAILED", "x", {}), url);
    assert.doesNotMatch(body, /usage limit/);
  });
});

describe("runUrl", () => {
  it("links the run when both parts are known", () => {
    assert.equal(runUrl({ owner: "acme", repo: "runner" }, 900), url);
    assert.equal(runUrl(undefined, 900), undefined);
    assert.equal(runUrl({ owner: "acme", repo: "runner" }, undefined), undefined);
  });
});
