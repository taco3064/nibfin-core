import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCommentVersions } from "./comment-edits.ts";
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
