import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeResult,
  claudeUsageLimit,
  codexUsageLimit,
  isClaudeLoginSignal,
  isCodexLoginSignal,
} from "./stream.ts";

describe("isClaudeLoginSignal", () => {
  it("detects authentication_failed on an assistant message", () => {
    const event = { type: "assistant", error: "authentication_failed" };
    assert.equal(isClaudeLoginSignal(event), true);
  });

  it("detects authentication_failed on a system/api_retry message", () => {
    const event = {
      type: "system",
      subtype: "api_retry",
      error: "authentication_failed",
    };
    assert.equal(isClaudeLoginSignal(event), true);
  });

  it("ignores other errors and other message types", () => {
    assert.equal(isClaudeLoginSignal({ type: "assistant", error: "rate_limit" }), false);
    assert.equal(isClaudeLoginSignal({ type: "assistant" }), false);
    const init = { type: "system", subtype: "init", error: "authentication_failed" };
    assert.equal(isClaudeLoginSignal(init), false);
    const user = { type: "user", error: "authentication_failed" };
    assert.equal(isClaudeLoginSignal(user), false);
  });
});

describe("claudeResult", () => {
  it("returns the result text of a successful result message", () => {
    const event = { type: "result", subtype: "success", is_error: false, result: "done" };
    assert.equal(claudeResult(event), "done");
  });

  it("ignores error results, non-result messages and missing text", () => {
    assert.equal(
      claudeResult({ type: "result", is_error: true, result: "x" }),
      undefined,
    );
    assert.equal(claudeResult({ type: "assistant", result: "x" }), undefined);
    assert.equal(claudeResult({ type: "result" }), undefined);
  });
});

describe("isCodexLoginSignal", () => {
  const expired =
    "Your access token could not be refreshed because your refresh token has " +
    "expired. Please log out and sign in again.";
  const mismatch =
    "Your access token could not be refreshed because you have since logged out " +
    "or signed in to another account. Please sign in again.";

  it("detects auth-refresh failures on error events", () => {
    assert.equal(isCodexLoginSignal({ type: "error", message: expired }), true);
    assert.equal(isCodexLoginSignal({ type: "error", message: mismatch }), true);
  });

  it("detects auth-refresh failures on turn.failed events", () => {
    const event = { type: "turn.failed", error: { message: expired } };
    assert.equal(isCodexLoginSignal(event), true);
  });

  it("ignores other failures and events", () => {
    assert.equal(isCodexLoginSignal({ type: "error", message: "boom" }), false);
    assert.equal(isCodexLoginSignal({ type: "error" }), false);
    assert.equal(isCodexLoginSignal({ type: "turn.failed", error: "x" }), false);
    const done = { type: "turn.completed", message: expired };
    assert.equal(isCodexLoginSignal(done), false);
  });
});

describe("claudeUsageLimit", () => {
  const event = (info: unknown) => ({ type: "rate_limit_event", rate_limit_info: info });
  // 2026-11-24T18:00:00Z
  const resetsAt = 1795543200;

  it("reports a rejection with its type and reset time in UTC", () => {
    const info = { status: "rejected", rateLimitType: "five_hour", resetsAt };
    assert.deepEqual(claudeUsageLimit(event(info)), {
      rejected: true,
      type: "five_hour",
      reset: "2026-11-24T18:00:00Z",
    });
  });

  it("reports allowed and allowed_warning as not rejected", () => {
    const allowed = { status: "allowed", rateLimitType: "seven_day", resetsAt };
    assert.deepEqual(claudeUsageLimit(event(allowed)), {
      rejected: false,
      type: "seven_day",
      reset: "2026-11-24T18:00:00Z",
    });
    const warning = event({ status: "allowed_warning" });
    assert.deepEqual(claudeUsageLimit(warning), { rejected: false });
  });

  it("leaves out a missing or malformed reset time and type", () => {
    assert.deepEqual(claudeUsageLimit(event({ status: "rejected" })), {
      rejected: true,
    });
    for (const bad of [1.5, "1795543200", 1e300, 9e15, Number.NaN]) {
      const info = { status: "rejected", resetsAt: bad, rateLimitType: "Five hour!" };
      assert.deepEqual(claudeUsageLimit(event(info)), { rejected: true });
    }
  });

  it("ignores other events", () => {
    assert.equal(claudeUsageLimit({ type: "rate_limit_event" }), undefined);
    assert.equal(claudeUsageLimit(event("rejected")), undefined);
    const other = { type: "system", rate_limit_info: { status: "rejected" } };
    assert.equal(claudeUsageLimit(other), undefined);
  });
});

describe("codexUsageLimit", () => {
  const limit = "You’ve hit your usage limit. Upgrade to Pro for more.";

  it("detects the usage-limit message with either apostrophe", () => {
    assert.deepEqual(codexUsageLimit({ type: "error", message: limit }), {
      rejected: true,
    });
    const plain = { type: "error", message: "You've hit your usage limit." };
    assert.deepEqual(codexUsageLimit(plain), { rejected: true });
  });

  it("takes the time of the Try again at clause", () => {
    const message = `${limit} Try again at Nov 24th, 2026 6:00 PM.`;
    const event = { type: "turn.failed", error: { message } };
    assert.deepEqual(codexUsageLimit(event), {
      rejected: true,
      reset: "Nov 24th, 2026 6:00 PM",
    });
    const mid = { type: "error", message: `${limit} Try again at 18:00. Thanks` };
    assert.deepEqual(codexUsageLimit(mid), { rejected: true, reset: "18:00" });
  });

  it("drops a Try again at clause that is too long or not plain", () => {
    for (const time of ["x".repeat(65), "`now` @owner", "soon"]) {
      const suffix = time === "soon" ? `Try again at ${time}` : `Try again at ${time}.`;
      const event = { type: "error", message: `${limit} ${suffix}` };
      assert.deepEqual(codexUsageLimit(event), { rejected: true });
    }
  });

  it("ignores other failures and events", () => {
    assert.equal(codexUsageLimit({ type: "error", message: "boom" }), undefined);
    assert.equal(codexUsageLimit({ type: "turn.completed", message: limit }), undefined);
  });
});
