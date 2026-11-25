import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { fakeGitHub, networkError, paged, rejection, repo } from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";
import {
  readApprovalCount,
  readCommitPullRequests,
  readCommitsAhead,
  readForcePushedHeads,
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

describe("readCommitPullRequests", () => {
  it("lists the pull requests of a commit with title and URL", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/commits/abc/pulls": paged([
        { ...pull(330), title: "Add the widget" },
      ]),
    });
    assert.deepEqual(await readCommitPullRequests(github.client, repo, "abc"), [
      {
        number: 330,
        title: "Add the widget",
        url: "https://github.com/acme/app/pull/330",
      },
    ]);
  });

  it("fails when they cannot be read", async () => {
    const github = fakeGitHub();
    await expectReadFailure(readCommitPullRequests(github.client, repo, "abc"));
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

describe("readForcePushedHeads", () => {
  function page(oids: Array<string | null>, cursor: string | null) {
    const nodes = oids.map((oid) => (oid === null ? {} : { beforeCommit: { oid } }));
    const pageInfo = { hasNextPage: cursor !== null, endCursor: cursor };
    const timelineItems = { pageInfo, nodes };
    return { data: { data: { repository: { pullRequest: { timelineItems } } } } };
  }

  it("reads the head before each force push, all pages", async () => {
    const pages = [page(["a", null], "c1"), page(["b"], null)];
    const github = fakeGitHub({ "POST /graphql": () => pages.shift()! });
    assert.deepEqual(await readForcePushedHeads(github.client, repo, 7), ["a", "b"]);
    const variables = github.calls.map(
      (call) => (call.body as { variables: unknown }).variables,
    );
    assert.deepEqual(variables, [
      { owner: "acme", repo: "app", number: 7, cursor: null },
      { owner: "acme", repo: "app", number: 7, cursor: "c1" },
    ]);
  });

  for (const [name, data] of [
    ["GraphQL errors", { errors: [{ message: "x" }], data: null }],
    ["a missing pull request", { data: { repository: { pullRequest: null } } }],
  ] as const) {
    it(`fails on ${name}`, async () => {
      const github = fakeGitHub({ "POST /graphql": { data } });
      await expectReadFailure(readForcePushedHeads(github.client, repo, 7));
    });
  }
});

describe("readCommitsAhead", () => {
  it("lists the commits of a head that the base lacks", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/compare/main...abc": {
        data: { commits: [{ sha: "x" }, { sha: "abc" }] },
      },
    });
    assert.deepEqual(await readCommitsAhead(github.client, repo, "main", "abc"), [
      "x",
      "abc",
    ]);
  });

  it("treats a head GitHub no longer has as absent and fails otherwise", async () => {
    const gone = fakeGitHub();
    assert.equal(await readCommitsAhead(gone.client, repo, "main", "abc"), undefined);
    const broken = fakeGitHub({
      "GET /repos/acme/app/compare/main...abc": networkError(),
    });
    await expectReadFailure(readCommitsAhead(broken.client, repo, "main", "abc"));
  });
});
