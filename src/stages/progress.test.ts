import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeActor, fakeGitHub, paged } from "../github/fake-github.test.ts";
import { isWriteRoute, trackProgress } from "./progress.ts";

describe("trackProgress", () => {
  it("counts writes of its client, not reads or GraphQL queries", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": { data: {} },
      "GET /repos/acme/app/issues": paged([]),
      "POST /graphql": { data: { data: {} } },
      "POST /repos/acme/app/issues/1/comments": { status: 201, data: {} },
    });
    const progress = trackProgress(github.client);
    assert.equal(progress.client.actor, fakeActor);
    const repo = { owner: "acme", repo: "app" };
    await progress.client.request("GET /repos/{owner}/{repo}", repo);
    await progress.client.paginate("GET /repos/{owner}/{repo}/issues", repo);
    await progress.client.request("POST /graphql", { query: "query { x }" });
    assert.equal(progress.progressed, false);
    await progress.client.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { ...repo, issue_number: 1, body: "x" },
    );
    assert.equal(progress.progressed, true);
  });

  it("records a push or a moved head by mark", () => {
    const progress = trackProgress(fakeGitHub().client);
    progress.mark();
    assert.equal(progress.progressed, true);
  });

  it("classifies routes given as strings or objects", () => {
    assert.equal(isWriteRoute("PATCH /repos/{owner}/{repo}/issues/{issue_number}"), true);
    assert.equal(isWriteRoute({ method: "PUT", url: "/x" }), true);
    assert.equal(isWriteRoute({ method: "GET", url: "/x" }), false);
    assert.equal(isWriteRoute({ url: "/x" }), false);
  });
});
