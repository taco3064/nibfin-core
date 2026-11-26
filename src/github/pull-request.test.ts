import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import {
  failure,
  fakeGitHub,
  networkError,
  paged,
  rejection,
  repo,
} from "./fake-github.test.ts";
import { pull } from "./fixtures.test.ts";
import {
  hasWritePermission,
  readApprovalCount,
  readCommitPullRequests,
  readCommitsAhead,
  readForcePushedHeads,
  readPullRequest,
  readLatestReviews,
  readPullRequestCommits,
  readRequestedReviewers,
  readReviewComments,
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
        { ...pull(330), title: "Add the widget", body: "Part of #12" },
        { ...pull(331), title: "Fix it", body: null },
      ]),
    });
    assert.deepEqual(await readCommitPullRequests(github.client, repo, "abc"), [
      {
        number: 330,
        title: "Add the widget",
        url: "https://github.com/acme/app/pull/330",
        body: "Part of #12",
      },
      {
        number: 331,
        title: "Fix it",
        url: "https://github.com/acme/app/pull/331",
        body: "",
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

describe("readLatestReviews", () => {
  it("keeps each reviewer's latest submitted review, all pages", async () => {
    const reviews = [
      { id: 9, user: { id: 1, login: "ann" }, state: "PENDING" },
      { id: 3, user: { id: 1, login: "ann" }, state: "COMMENTED" },
      {
        id: 2,
        user: { id: 1, login: "ann" },
        state: "CHANGES_REQUESTED",
        commit_id: "abc",
        html_url: "https://x/r2",
        body: "Fix it.",
      },
      { id: 1, user: { id: 1, login: "ann" }, state: "APPROVED" },
      { id: 4, user: null, state: "APPROVED" },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: 10 + index,
        user: { id: 2, login: "bob" },
        state: "APPROVED",
        commit_id: null,
        html_url: `https://x/r${10 + index}`,
        body: null,
      })),
    ];
    const github = fakeGitHub({ "GET /repos/acme/app/pulls/7/reviews": paged(reviews) });
    assert.deepEqual(await readLatestReviews(github.client, repo, 7), [
      {
        id: 2,
        login: "ann",
        state: "CHANGES_REQUESTED",
        commitId: "abc",
        url: "https://x/r2",
        body: "Fix it.",
      },
      {
        id: 109,
        login: "bob",
        state: "APPROVED",
        commitId: null,
        url: "https://x/r109",
        body: "",
      },
    ]);
  });
});

describe("readReviewComments", () => {
  it("lists a review's inline comments, all pages", async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({
      path: "a.ts",
      line: index === 0 ? null : index,
      body: `c${index}`,
      html_url: `https://x/c${index}`,
    }));
    const github = fakeGitHub({
      "GET /repos/acme/app/pulls/7/reviews/5/comments": paged(comments),
    });
    const read = await readReviewComments(github.client, repo, 7, 5);
    assert.equal(read.length, 101);
    assert.deepEqual(read[0], {
      path: "a.ts",
      line: null,
      body: "c0",
      url: "https://x/c0",
    });
    assert.deepEqual(read[100], {
      path: "a.ts",
      line: 100,
      body: "c100",
      url: "https://x/c100",
    });
  });

  it("fails when they cannot be read", async () => {
    await expectReadFailure(readReviewComments(fakeGitHub().client, repo, 7, 5));
  });
});

describe("readRequestedReviewers", () => {
  it("reads the requested users and teams", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/pulls/7/requested_reviewers": {
        data: { users: [{ login: "ann" }], teams: [{ slug: "core" }] },
      },
    });
    assert.deepEqual(await readRequestedReviewers(github.client, repo, 7), {
      users: ["ann"],
      teams: ["core"],
    });
  });

  it("fails when they cannot be read", async () => {
    await expectReadFailure(readRequestedReviewers(fakeGitHub().client, repo, 7));
  });
});

describe("hasWritePermission", () => {
  const path = "GET /repos/acme/app/collaborators/ann/permission";

  for (const [permission, expected] of [
    ["admin", true],
    ["write", true],
    ["read", false],
    ["none", false],
  ] as const) {
    it(`reads ${permission} as ${expected ? "" : "no "}write access`, async () => {
      const github = fakeGitHub({ [path]: { data: { permission } } });
      assert.equal(await hasWritePermission(github.client, repo, "ann"), expected);
    });
  }

  it("reads a non-collaborator (404) as no write access", async () => {
    assert.equal(await hasWritePermission(fakeGitHub().client, repo, "ann"), false);
  });

  it("fails on any other failure", async () => {
    const github = fakeGitHub({ [path]: failure(500) });
    await expectReadFailure(hasWritePermission(github.client, repo, "ann"));
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
