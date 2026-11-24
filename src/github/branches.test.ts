import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cdFixBranch,
  deliveryBranch,
  issueOfBranch,
  readPullRequests,
} from "./branches.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";

const pulls = "GET /repos/acme/app/pulls";

describe("branch names", () => {
  it("names the delivery and fix branches", () => {
    assert.equal(deliveryBranch(667), "nibfin/issue-667");
    assert.equal(cdFixBranch(667, 2), "nibfin/issue-667-cd-2");
    assert.equal(issueOfBranch("nibfin/issue-667"), 667);
    assert.equal(issueOfBranch("nibfin/issue-667-cd-2"), 667);
    for (const other of [
      "main",
      "nibfin/issue-",
      "nibfin/issue-01",
      "nibfin/issue-6-cd-0",
    ]) {
      assert.equal(issueOfBranch(other), undefined, other);
    }
  });
});

describe("readPullRequests", () => {
  it("lists every page for the exact head, newest first", async () => {
    const items = Array.from({ length: 150 }, (_, index) =>
      pull(index + 1, { head: "nibfin/issue-1", state: "closed" }),
    );
    items.push(pull(999, { head: "nibfin/issue-10" }));
    const github = fakeGitHub({ [pulls]: paged(items) });
    const result = await readPullRequests(github.client, repo, "nibfin/issue-1");
    assert.equal(result.length, 150);
    assert.equal(result[0]?.number, 150);
    assert.equal(result.at(-1)?.number, 1);
    assert.equal(github.calls.length, 2);
    const query = github.calls[0]?.query;
    assert.equal(query?.get("head"), "acme:nibfin/issue-1");
    assert.equal(query?.get("state"), "all");
    assert.equal(query?.get("per_page"), "100");
  });

  it("summarizes open, merged and closed pull requests", async () => {
    const github = fakeGitHub({
      [pulls]: paged([
        pull(1, { merged: true, sha: "a", mergeSha: "m" }),
        pull(2, { state: "closed" }),
        pull(3, { base: "dev" }),
      ]),
    });
    const [open, closed, merged] = await readPullRequests(
      github.client,
      repo,
      "nibfin/issue-1",
      "open",
    );
    assert.equal(github.calls[0]?.query.get("state"), "open");
    assert.deepEqual(open, {
      number: 3,
      state: "open",
      merged: false,
      headRef: "nibfin/issue-1",
      headSha: "head-3",
      baseRef: "dev",
      mergeCommitSha: null,
      url: "https://github.com/acme/app/pull/3",
    });
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.merged, false);
    assert.equal(merged?.merged, true);
    assert.equal(merged?.mergeCommitSha, "m");
  });

  it("fails the whole list when a page fails", async () => {
    let page = 0;
    const items = Array.from({ length: 120 }, (_, index) => pull(index + 1));
    const list = paged(items);
    const github = fakeGitHub({
      [pulls]: (request) => {
        page += 1;
        return page === 1 ? list(request) : failure(502);
      },
    });
    const error = await rejection(
      readPullRequests(github.client, repo, "nibfin/issue-1"),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});
