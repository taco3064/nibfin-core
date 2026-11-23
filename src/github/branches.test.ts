import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cdFixBranch,
  deliveryBranch,
  probeBranch,
  readIssueBranches,
  readPullRequests,
} from "./branches.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";

const pulls = "GET /repos/acme/app/pulls";
const ref = (branch: string) => `GET /repos/acme/app/git/ref/heads/${branch}`;
const found = { data: { ref: "refs/heads/x" } };

describe("branch names", () => {
  it("names the delivery and fix branches", () => {
    assert.equal(deliveryBranch(667), "nibfin/issue-667");
    assert.equal(cdFixBranch(667, 2), "nibfin/issue-667-cd-2");
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

describe("probeBranch", () => {
  it("reports an existing ref through the exact ref endpoint", async () => {
    const github = fakeGitHub({ [pulls]: paged([]), [ref("nibfin/issue-1")]: found });
    const probe = await probeBranch(github.client, repo, "nibfin/issue-1");
    assert.deepEqual(probe, { name: "nibfin/issue-1", exists: true, pullRequests: [] });
  });

  it("treats a 404 ref as absent but fails on other errors", async () => {
    const absent = fakeGitHub({ [pulls]: paged([]) });
    const probe = await probeBranch(absent.client, repo, "nibfin/issue-1");
    assert.equal(probe.exists, false);
    const broken = fakeGitHub({
      [pulls]: paged([]),
      [ref("nibfin/issue-1")]: failure(403),
    });
    const error = await rejection(probeBranch(broken.client, repo, "nibfin/issue-1"));
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
  });
});

describe("readIssueBranches", () => {
  const pullsBy = (byHead: Record<string, unknown[]>) =>
    fakeGitHub({
      [pulls]: (request) => {
        const head = request.query.get("head")?.replace("acme:", "") ?? "";
        return paged(byHead[head] ?? [])(request);
      },
    });

  it("uses the delivery branch when no fix branch exists", async () => {
    const github = pullsBy({ "nibfin/issue-1": [pull(5)] });
    const branches = await readIssueBranches(github.client, repo, 1);
    assert.equal(branches.current.name, "nibfin/issue-1");
    assert.equal(branches.current, branches.delivery);
    assert.deepEqual(branches.fixes, []);
    assert.equal(branches.nextFixBranch, "nibfin/issue-1-cd-1");
  });

  it("finds fix branches by pull request or ref up to the first missing k", async () => {
    const github = pullsBy({
      "nibfin/issue-1": [pull(5, { merged: true })],
      "nibfin/issue-1-cd-1": [pull(6, { head: "nibfin/issue-1-cd-1", merged: true })],
    });
    github.routes.set(ref("nibfin/issue-1-cd-2"), found);
    const branches = await readIssueBranches(github.client, repo, 1);
    assert.deepEqual(
      branches.fixes.map((fix) => [fix.name, fix.exists, fix.pullRequests.length]),
      [
        ["nibfin/issue-1-cd-1", false, 1],
        ["nibfin/issue-1-cd-2", true, 0],
      ],
    );
    assert.equal(branches.current.name, "nibfin/issue-1-cd-2");
    assert.equal(branches.nextFixBranch, "nibfin/issue-1-cd-3");
  });
});
