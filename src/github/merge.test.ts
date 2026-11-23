import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError, responseMessage } from "./errors.ts";
import {
  type FakeResponse,
  failure,
  fakeGitHub,
  networkError,
  rejection,
  repo,
  type Route,
} from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";
import { mergePullRequest } from "./writes.ts";

const request = { number: 7, sha: "abc", method: "squash" as const };

function mergeFake(merge: Route, after: FakeResponse = { data: pull(7) }) {
  return fakeGitHub({
    "PUT /repos/acme/app/pulls/7/merge": merge,
    "GET /repos/acme/app/pulls/7": after,
  });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(error.code, code);
  return error;
}

describe("mergePullRequest", () => {
  it("merges at the pinned head with the chosen method", async () => {
    const github = mergeFake({ data: { sha: "m1", merged: true, message: "ok" } });
    assert.deepEqual(await mergePullRequest(github.client, repo, request), {
      outcome: "merged",
      mergeCommitSha: "m1",
    });
    assert.deepEqual(github.writes()[0]?.body, { sha: "abc", merge_method: "squash" });
  });

  it("reports a moved head (409) and an unmergeable pull request (405)", async () => {
    const moved = mergeFake(failure(409, "Head branch was modified"));
    assert.deepEqual(await mergePullRequest(moved.client, repo, request), {
      outcome: "head-changed",
    });
    const blocked = mergeFake(failure(405, "Base branch was modified."));
    assert.deepEqual(await mergePullRequest(blocked.client, repo, request), {
      outcome: "not-mergeable",
      message: "Base branch was modified.",
    });
    const silent = mergeFake({ status: 405, data: {} });
    assert.deepEqual(await mergePullRequest(silent.client, repo, request), {
      outcome: "not-mergeable",
      message: "The merge cannot be performed",
    });
  });

  for (const status of [403, 404, 422]) {
    it(`rejects a ${status}`, async () => {
      const github = mergeFake(failure(status, "nope"));
      const error = await expectCode(
        mergePullRequest(github.client, repo, request),
        "GITHUB_WRITE_REJECTED",
      );
      assert.equal(responseMessage(error.cause), "nope");
    });
  }

  it("confirms an unknown outcome by the merged pull request at the head", async () => {
    const merged = { data: pull(7, { merged: true, sha: "abc", mergeSha: "m2" }) };
    const github = mergeFake(failure(502), merged);
    assert.deepEqual(await mergePullRequest(github.client, repo, request), {
      outcome: "merged",
      mergeCommitSha: "m2",
    });
  });

  for (const [name, after] of [
    ["still open", { data: pull(7, { sha: "abc" }) }],
    ["merged at another head", { data: pull(7, { merged: true, sha: "def" }) }],
    ["unreadable", failure(500)],
  ] as const) {
    it(`leaves an unknown outcome unconfirmed when the PR is ${name}`, async () => {
      const github = mergeFake(networkError(), after);
      await expectCode(
        mergePullRequest(github.client, repo, request),
        "GITHUB_WRITE_UNCONFIRMED",
      );
    });
  }
});

describe("responseMessage", () => {
  it("reads GitHub's message only from an answered error", () => {
    assert.equal(responseMessage({ response: { data: { message: "m" } } }), "m");
    assert.equal(responseMessage({ response: { data: { message: 1 } } }), undefined);
    assert.equal(responseMessage({ response: { data: undefined } }), undefined);
    assert.equal(responseMessage(new Error("x")), undefined);
  });
});
