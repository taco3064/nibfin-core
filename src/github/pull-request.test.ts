import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { fakeGitHub, networkError, paged, rejection, repo } from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";
import {
  readApprovalCount,
  readPullRequest,
  readPullRequestCommits,
} from "./pull-request.ts";

async function expectReadFailure(promise: Promise<unknown>) {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError);
  assert.equal(error.code, "GITHUB_READ_FAILED");
}

describe("readPullRequest", () => {
  it("reads the pull request with its mergeability", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/pulls/7": {
        data: { ...pull(7, { sha: "abc" }), mergeable: null, mergeable_state: "unknown" },
      },
    });
    const read = await readPullRequest(github.client, repo, 7);
    assert.equal(read.headSha, "abc");
    assert.equal(read.mergeable, null);
    assert.equal(read.mergeableState, "unknown");
    assert.equal(read.merged, false);
  });

  it("fails when it cannot be read", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app/pulls/7": networkError() });
    await expectReadFailure(readPullRequest(github.client, repo, 7));
  });
});

describe("readPullRequestCommits", () => {
  it("lists every commit SHA, all pages", async () => {
    const commits = Array.from({ length: 101 }, (_, index) => ({ sha: `c${index}` }));
    const github = fakeGitHub({
      "GET /repos/acme/app/pulls/7/commits": paged(commits),
    });
    const shas = await readPullRequestCommits(github.client, repo, 7);
    assert.equal(shas.length, 101);
    assert.equal(shas.at(-1), "c100");
  });

  it("fails when a page cannot be read", async () => {
    const github = fakeGitHub();
    await expectReadFailure(readPullRequestCommits(github.client, repo, 7));
  });
});

describe("readApprovalCount", () => {
  it("counts reviewers whose latest deciding review approves", async () => {
    const review = (id: number, user: number | null, state: string) => ({
      id,
      user: user === null ? null : { id: user, login: `u${user}` },
      state,
    });
    const github = fakeGitHub({
      "GET /repos/acme/app/pulls/7/reviews": paged([
        review(5, 1, "COMMENTED"),
        review(1, 1, "APPROVED"),
        review(2, 2, "APPROVED"),
        review(3, 2, "CHANGES_REQUESTED"),
        review(4, 3, "APPROVED"),
        review(6, 3, "DISMISSED"),
        review(7, null, "APPROVED"),
        review(8, 4, "APPROVED"),
      ]),
    });
    assert.equal(await readApprovalCount(github.client, repo, 7), 2);
  });

  it("fails when the reviews cannot be read", async () => {
    const github = fakeGitHub();
    await expectReadFailure(readApprovalCount(github.client, repo, 7));
  });
});
