import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubError,
  hasResponse,
  isUnknownOutcome,
  read,
  readOptional,
  statusOf,
} from "./errors.ts";
import {
  failure,
  fakeGitHub,
  fakeToken,
  networkError,
  rejection,
} from "./fake-github.test.ts";

const answered = (status: number) => ({ status, response: { status } });

describe("GitHubError", () => {
  it("keeps the code, operation and original cause", () => {
    const cause = answered(403);
    const error = new GitHubError("GITHUB_READ_FAILED", "read acme/app#1", cause);
    assert.equal(error.name, "GitHubError");
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(error.operation, "read acme/app#1");
    assert.equal(error.cause, cause);
    assert.equal(error.message, "read acme/app#1: read failed (HTTP 403)");
  });

  it("names each code and a cause without a response", () => {
    const unconfirmed = new GitHubError("GITHUB_WRITE_UNCONFIRMED", "op", new Error("x"));
    assert.equal(unconfirmed.message, "op: write outcome unconfirmed (no response)");
    const rejected = new GitHubError("GITHUB_WRITE_REJECTED", "op", answered(422));
    assert.equal(rejected.message, "op: write rejected (HTTP 422)");
  });

  it("never puts the token or headers in the message", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/1": failure(429, "API rate limit exceeded"),
      "GET /repos/acme/app/issues/2": networkError(),
    });
    for (const number of [1, 2]) {
      const error = await rejection(
        read("read issue", () =>
          github.client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            owner: "acme",
            repo: "app",
            issue_number: number,
          }),
        ),
      );
      assert.ok(error instanceof GitHubError);
      assert.doesNotMatch(error.message, /authorization|ghs_|token/i);
      assert.doesNotMatch(String(error), new RegExp(fakeToken));
      const cause = error.cause as { request: { headers: Record<string, string> } };
      assert.doesNotMatch(
        cause.request.headers.authorization ?? "",
        new RegExp(fakeToken),
      );
    }
    const sent = github.calls[0]?.headers.authorization;
    assert.equal(sent, `token ${fakeToken}`);
  });

  it("keeps a rate limit identifiable in the cause", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/1": {
        status: 403,
        data: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const error = await rejection(
      read("read issue", () =>
        github.client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          owner: "acme",
          repo: "app",
          issue_number: 1,
        }),
      ),
    );
    const cause = (error as GitHubError).cause as {
      status: number;
      response: { headers: Record<string, string> };
    };
    assert.equal(cause.status, 403);
    assert.equal(cause.response.headers["x-ratelimit-remaining"], "0");
  });
});

describe("error classification", () => {
  it("reads the status and response of an error", () => {
    assert.equal(statusOf(answered(404)), 404);
    assert.equal(statusOf({ status: "404" }), undefined);
    assert.equal(statusOf(null), undefined);
    assert.equal(statusOf("x"), undefined);
    assert.equal(hasResponse(answered(500)), true);
    assert.equal(hasResponse({ status: 500 }), false);
    assert.equal(hasResponse(null), false);
    assert.equal(hasResponse(1), false);
  });

  it("treats no response and server errors as unknown outcomes", () => {
    assert.equal(isUnknownOutcome({ status: 500 }), true);
    assert.equal(isUnknownOutcome(new Error("x")), true);
    assert.equal(isUnknownOutcome({ response: {} }), true);
    assert.equal(isUnknownOutcome(answered(502)), true);
    assert.equal(isUnknownOutcome(answered(500)), true);
    assert.equal(isUnknownOutcome(answered(422)), false);
    assert.equal(isUnknownOutcome(answered(404)), false);
  });
});

describe("read", () => {
  it("returns the result or fails with GITHUB_READ_FAILED and the cause", async () => {
    assert.equal(await read("op", async () => 1), 1);
    const cause = answered(500);
    const error = await rejection(read("op", () => Promise.reject(cause)));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(error.cause, cause);
  });

  it("passes a GitHubError through unchanged", async () => {
    const inner = new GitHubError("GITHUB_READ_FAILED", "inner", new Error("x"));
    assert.equal(await rejection(read("outer", () => Promise.reject(inner))), inner);
  });
});

describe("readOptional", () => {
  it("maps an answered 404 to absent", async () => {
    assert.equal(
      await readOptional("op", () => Promise.reject(answered(404))),
      undefined,
    );
    assert.equal(await readOptional("op", async () => "x"), "x");
  });

  it("fails on any other error, including a 404 without a response", async () => {
    for (const cause of [{ status: 404 }, answered(403), answered(500)]) {
      const error = await rejection(readOptional("op", () => Promise.reject(cause)));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    }
  });
});
