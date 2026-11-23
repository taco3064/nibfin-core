import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCommentVersions, readCommentWithVersions } from "./comment-edits.ts";
import { GitHubError } from "./errors.ts";
import { type FakeResponse, fakeGitHub, rejection, repo } from "./fake-github.test.ts";

function edits(response: FakeResponse) {
  return fakeGitHub({
    "GET /repos/acme/app/issues/comments/9": { data: { id: 9, node_id: "IC_9" } },
    "POST /graphql": response,
  });
}

describe("readCommentVersions", () => {
  it("counts a comment never edited as one version", async () => {
    const github = edits({
      data: { data: { node: { userContentEdits: { totalCount: 0 } } } },
    });
    assert.equal(await readCommentVersions(github.client, repo, 9), 1);
    const query = github.calls[1]?.body as { query: string; variables: unknown };
    assert.match(query.query, /userContentEdits/);
    assert.deepEqual(query.variables, { id: "IC_9" });
  });

  it("counts every edit plus the original of an edited comment", async () => {
    const github = edits({
      data: { data: { node: { userContentEdits: { totalCount: 3 } } } },
    });
    assert.equal(await readCommentVersions(github.client, repo, 9), 3);
  });

  for (const [name, data] of [
    ["GraphQL errors", { data: { node: null }, errors: [{ message: "x" }] }],
    ["a missing node", { data: { node: null } }],
    ["no data", {}],
  ] as const) {
    it(`fails on ${name}`, async () => {
      const error = await rejection(readCommentVersions(edits({ data }).client, repo, 9));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    });
  }

  it("fails when the comment cannot be read", async () => {
    const github = fakeGitHub();
    const error = await rejection(readCommentVersions(github.client, repo, 9));
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
  });
});

describe("readCommentWithVersions", () => {
  it("reads the body and the versions in one query on the node", async () => {
    const body = "<!-- nibfin:shape -->\nPlan";
    const node = { body, userContentEdits: { totalCount: 2 } };
    const github = edits({ data: { data: { node } } });
    assert.deepEqual(await readCommentWithVersions(github.client, repo, 9), {
      body,
      versions: 2,
    });
    const graphql = github.calls.filter((call) => call.path === "/graphql");
    assert.equal(graphql.length, 1);
    const query = graphql[0].body as { query: string; variables: unknown };
    assert.match(query.query, /body\s+userContentEdits/);
    assert.deepEqual(query.variables, { id: "IC_9" });
  });

  it("counts a comment never edited as one version", async () => {
    const node = { body: "x", userContentEdits: { totalCount: 0 } };
    const github = edits({ data: { data: { node } } });
    assert.equal((await readCommentWithVersions(github.client, repo, 9)).versions, 1);
  });

  for (const [name, data] of [
    ["no body", { data: { node: { userContentEdits: { totalCount: 1 } } } }],
    ["no edit count", { data: { node: { body: "x" } } }],
    ["GraphQL errors", { data: { node: null }, errors: [{ message: "x" }] }],
  ] as const) {
    it(`fails on ${name}`, async () => {
      const github = edits({ data });
      const error = await rejection(readCommentWithVersions(github.client, repo, 9));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    });
  }
});
