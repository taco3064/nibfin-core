import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeResult, isClaudeLoginSignal, isCodexLoginSignal } from "./stream.ts";

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
