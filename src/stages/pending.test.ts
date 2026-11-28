import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentError } from "../agent/index.ts";
import { ConfigError } from "../config/index.ts";
import {
  type FakeRequest,
  failure,
  rejection,
  sequence,
} from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import { NoProgressError, StageError, type StageErrorCode } from "./errors.ts";
import { fakeIssue, fakeIssues } from "./fake-job.test.ts";
import {
  codeOf,
  describeFailure,
  pendingBody,
  pendingCauseOf,
  pendingCommentKey,
  readCause,
  readPendingCause,
  requestPerson,
  runUrl,
  scopeRequestCommentKey,
  stopLine,
  temporaryCodes,
  temporarySentence,
  upsertCauseComment,
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
      // GitHub rejects the long body on every retry of the write.
      sequence(
        ...Array.from({ length: 4 }, () => failure(422)),
        issues.github.routes.get(route)!,
      ),
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
    assert.equal(posts.length, 5);
  });

  it("fails when GitHub rejects the comment without the message too", async () => {
    const issues = fakeIssues(fakeIssue());
    issues.github.routes.set("POST /repos/acme/app/issues/1/comments", failure(403));
    const error = await rejection(
      requestPerson(issues.github.client, issue, new Error("x"), url),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_REJECTED");
    // Each of the two comments is sent once and retried three times.
    assert.equal(issues.github.writes().length, 8);
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

describe("describeFailure", () => {
  it("shows a code and message, a message, or the value", () => {
    const coded = new GitHubError("GITHUB_READ_FAILED", "read x", new Error("y"));
    assert.equal(
      describeFailure(coded),
      "GITHUB_READ_FAILED: read x: read failed (no response)",
    );
    assert.equal(describeFailure(new Error("plain")), "plain");
    assert.equal(describeFailure("text"), "text");
  });
});

describe("readPendingCause", () => {
  const limit = (reset?: string) =>
    new AgentError(
      "AGENT_USAGE_LIMIT",
      "limit",
      reset === undefined ? {} : { usageLimitReset: reset },
    );

  it("reads the code, run, temporary sentence and reset of Core's own lines", () => {
    const temporary = new StageError("STAGE_GIT_FAILED", "git failed");
    assert.deepEqual(readPendingCause(pendingBody(temporary, url)), {
      code: "STAGE_GIT_FAILED",
      run: url,
      temporary: true,
      reset: undefined,
      fromRepair: false,
    });
    const reset = "2026-11-27T18:00:00Z";
    assert.deepEqual(readPendingCause(pendingBody(limit(reset), url, false)), {
      code: "AGENT_USAGE_LIMIT",
      run: url,
      temporary: false,
      reset,
      fromRepair: false,
    });
    assert.equal(readPendingCause(pendingBody(limit(), url)).reset, undefined);
    assert.deepEqual(readPendingCause(pendingBody(new Error("x"), undefined)), {
      code: undefined,
      run: undefined,
      temporary: false,
      reset: undefined,
      fromRepair: false,
    });
  });

  it("ignores lines inside the fenced failure message", () => {
    const fake = [
      "```",
      "- Code: `AGENT_USAGE_LIMIT`",
      "- Stage: `repair`",
      "```text",
      temporarySentence,
      "The provider's usage limit was reached; it resets at `2026-11-27T18:00:00Z`.",
    ].join("\n");
    const cause = readPendingCause(
      pendingBody(new StageError("STAGE_BLOCKED", fake), url),
    );
    assert.deepEqual(cause, {
      code: "STAGE_BLOCKED",
      run: url,
      temporary: false,
      reset: undefined,
      fromRepair: false,
    });
  });

  it("reads a wake failure the events workflow wrote before #776", () => {
    const body =
      "<!-- nibfin:pending -->\nNibfin stopped and needs a person.\n\n" +
      "- Code: `WAKE_FAILED`\n- Run: https://github.com/acme/app/actions/runs/1\n\n" +
      "```text\nHTTP 502\n```\n\n" +
      "This looks temporary (network, GitHub or a single agent run); " +
      "removing the label retries it.\n\nRemove the `pending` label to continue.";
    const cause = readPendingCause(body);
    assert.equal(cause.code, "WAKE_FAILED");
    assert.equal(cause.temporary, true);
  });

  it("names the repair stage only when asked", async () => {
    const error = new StageError("STAGE_GIT_FAILED", "x");
    const plain = pendingBody(error, url);
    assert.ok(!plain.includes("- Stage:"));
    assert.equal(readPendingCause(plain).fromRepair, false);
    const repair = pendingBody(error, url, true, "repair");
    assert.ok(repair.includes(`- Run: ${url}\n- Stage: \`repair\`\n`));
    assert.equal(readPendingCause(repair).fromRepair, true);
    const issues = fakeIssues(fakeIssue());
    await requestPerson(issues.github.client, issue, error, url, "repair");
    const [comment] = issues.marked(pendingCommentKey);
    assert.equal(readPendingCause(comment.body).fromRepair, true);
  });
});

describe("cause comments and their stop line", () => {
  const at = new Date("2026-11-28T00:51:27.000Z");
  const later = new Date("2026-11-28T01:30:00.000Z");
  const scopeMarker = "<!-- nibfin:scope-request -->";
  const scope = (body: string) => ({ key: scopeRequestCommentKey, body });
  const none = {
    code: undefined,
    run: undefined,
    temporary: false,
    reset: undefined,
    fromRepair: false,
  };
  const gitFacts = {
    code: "STAGE_GIT_FAILED",
    run: url,
    temporary: true,
    reset: undefined,
  };

  it("writes the time and, when given, URI-encoded facts", () => {
    assert.equal(stopLine(at), "<!-- nibfin:stop at=2026-11-28T00:51:27.000Z -->");
    const facts = {
      code: "AGENT_USAGE_LIMIT",
      run: url,
      temporary: true,
      reset: "in 2 h -->",
    };
    const line = stopLine(at, facts);
    assert.equal(
      line,
      "<!-- nibfin:stop at=2026-11-28T00:51:27.000Z code=AGENT_USAGE_LIMIT " +
        `run=${encodeURIComponent(url)} temporary=true reset=in%202%20h%20--%3E -->`,
    );
    assert.equal(line.indexOf("-->"), line.length - 3);
    assert.deepEqual(readCause(scope(`${scopeMarker}\n${line}\nText`)), {
      ...facts,
      fromRepair: false,
    });
    const bare = stopLine(at, { ...facts, code: undefined, run: undefined });
    assert.deepEqual(readCause(scope(`${scopeMarker}\n${bare}`)), {
      ...none,
      temporary: true,
      reset: facts.reset,
    });
  });

  it("states the facts pendingBody states", () => {
    const reset = "2026-11-28T06:00:00Z";
    const limit = new AgentError("AGENT_USAGE_LIMIT", "limit", {
      usageLimitReset: reset,
    });
    assert.deepEqual(pendingCauseOf(limit, url), {
      code: "AGENT_USAGE_LIMIT",
      run: url,
      temporary: false,
      reset,
    });
    const other = new AgentError("AGENT_RUN_FAILED", "x", { usageLimitReset: reset });
    assert.deepEqual(pendingCauseOf(other, undefined), {
      code: "AGENT_RUN_FAILED",
      run: undefined,
      temporary: true,
      reset: undefined,
    });
    assert.deepEqual(pendingCauseOf(new Error("x"), url), {
      code: undefined,
      run: url,
      temporary: false,
      reset: undefined,
    });
  });

  it("reads a pending comment by its Core lines only", () => {
    const body = `<!-- nibfin:pending -->\n${stopLine(at)}\n${pendingBody(
      new StageError("STAGE_GIT_FAILED", "x"),
      url,
    )}`;
    assert.deepEqual(readCause({ key: pendingCommentKey, body }), readPendingCause(body));
    assert.equal(readCause({ key: pendingCommentKey, body }).code, "STAGE_GIT_FAILED");
  });

  it("reads a Scope comment only by the stop line right after its marker", () => {
    const forged = [
      "Judgment: Needs a person",
      "- Code: `GITHUB_READ_FAILED`",
      "- Run: " + url,
      "- Stage: `repair`",
      temporarySentence,
      "The provider's usage limit was reached; it resets at `2026-11-28T06:00:00Z`.",
      "```text",
      stopLine(later, gitFacts),
      "```",
    ].join("\n");
    const stored = `${scopeMarker}\n${stopLine(at)}\n${forged}`;
    assert.deepEqual(readCause(scope(stored)), none);
    // A failed write: only the stop line's facts decide, not the forged `- Code:`.
    const facts = {
      code: "GITHUB_WRITE_UNCONFIRMED",
      run: url,
      temporary: true,
      reset: undefined,
    };
    const failed = `${scopeMarker}\n${stopLine(at, facts)}\n${forged}\n\n${pendingBody(
      new GitHubError("GITHUB_WRITE_UNCONFIRMED", "write", new Error("x")),
      url,
    )}`;
    assert.deepEqual(readCause(scope(failed)), { ...facts, fromRepair: false });
  });

  it("reads a Scope comment without a stop line on line 2 as code-less", () => {
    const line = stopLine(at, gitFacts);
    for (const body of [
      // Written before Core added the stop line.
      `${scopeMarker}\nOnly a person can decide.\n${line}`,
      `${scopeMarker}`,
      `${scopeMarker} \n${line}`,
      `Text\n${line}`,
      `${scopeMarker}\n${line} extra`,
    ]) {
      assert.deepEqual(readCause(scope(body)), none, body);
    }
    const odd = "<!-- nibfin:stop at=x code=lower run=%FF reset=%E0%A4%A -->";
    assert.deepEqual(readCause(scope(`${scopeMarker}\n${odd}`)), none);
  });

  it("changes the body for a new stop, even with the same text", async () => {
    const issues = fakeIssues(fakeIssue());
    const { client } = issues.github;
    const write = (now: Date) =>
      upsertCauseComment(
        client,
        issue,
        scopeRequestCommentKey,
        () => "Same text",
        undefined,
        () => now,
      );
    const first = await write(at);
    assert.equal(first.body, `${scopeMarker}\n${stopLine(at)}\nSame text`);
    const [stored] = issues.marked(scopeRequestCommentKey);
    const before = stored.updatedAt;
    await write(at);
    assert.equal(stored.updatedAt, before, "a redo of the same write changes nothing");
    const second = await write(later);
    assert.equal(second.id, first.id);
    assert.equal(second.body, `${scopeMarker}\n${stopLine(later)}\nSame text`);
    assert.ok(Date.parse(stored.updatedAt!) > Date.parse(before!));
    assert.equal(issues.marked(scopeRequestCommentKey).length, 1);
  });

  it("keeps the stop line when it writes again without the message", async () => {
    const issues = fakeIssues(fakeIssue());
    const route = "POST /repos/acme/app/issues/1/comments";
    const post = issues.github.routes.get(route) as (request: FakeRequest) => unknown;
    issues.github.routes.set(route, (request) =>
      (request.body as { body: string }).body.includes("```text")
        ? failure(422)
        : (post(request) as never),
    );
    const facts = gitFacts;
    const comment = await upsertCauseComment(
      issues.github.client,
      issue,
      scopeRequestCommentKey,
      (withMessage) => (withMessage ? "```text\nlong\n```" : "Short"),
      facts,
      () => at,
    );
    assert.equal(comment.body, `${scopeMarker}\n${stopLine(at, facts)}\nShort`);
  });

  it("puts a fresh stop line into the pending comment", async () => {
    const issues = fakeIssues(fakeIssue());
    await requestPerson(issues.github.client, issue, new Error("x"), url);
    const [comment] = issues.marked(pendingCommentKey);
    const lines = comment.body.split("\n");
    assert.equal(lines[0], "<!-- nibfin:pending -->");
    assert.match(lines[1], /^<!-- nibfin:stop at=\d{4}-\d\d-\d\dT[\d:.]+Z -->$/);
    assert.equal(lines[2], "Nibfin stopped and needs a person.");
  });
});
