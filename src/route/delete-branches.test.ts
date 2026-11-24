import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeGitHub, paged, repo } from "../github/fake-github.test.ts";
import { issue, pull } from "../github/fixtures.test.ts";
import { deleteIssueBranches } from "./delete-branches.ts";
import { fakeBranches } from "./fake-branches.test.ts";

function world(refs: readonly string[], pulls: unknown[] = []) {
  const github = fakeGitHub({
    "GET /repos/acme/app/issues/1": { data: issue(1, { state: "closed" }) },
    "GET /repos/acme/app/pulls": paged(pulls),
  });
  const branches = fakeBranches(github, refs);
  const logs: string[] = [];
  const run = () =>
    deleteIssueBranches(github.client, repo, 1, (line) => logs.push(line));
  return { github, branches, logs, run };
}

describe("deleteIssueBranches", () => {
  it("deletes the delivery branch", async () => {
    const w = world(["nibfin/issue-1"]);
    await w.run();
    assert.deepEqual(w.branches.deleted, ["nibfin/issue-1"]);
    assert.deepEqual(w.logs, ["acme/app#1: deleted branch nibfin/issue-1"]);
  });

  it("deletes the delivery branch and every fix branch whose ref exists", async () => {
    // -cd-1 was merged and its ref deleted; its pull request keeps -cd-2 probed.
    const pulls = [pull(3, { head: "nibfin/issue-1-cd-1", merged: true })];
    const w = world(["nibfin/issue-1", "nibfin/issue-1-cd-2", "nibfin/issue-2"], pulls);
    await w.run();
    assert.deepEqual(w.branches.deleted, ["nibfin/issue-1", "nibfin/issue-1-cd-2"]);
    assert.ok(w.branches.live.has("nibfin/issue-2"));
  });

  it("writes nothing when no branch exists", async () => {
    const pulls = [pull(3, { head: "nibfin/issue-1", merged: true })];
    const w = world([], pulls);
    await w.run();
    assert.deepEqual(w.github.writes(), []);
    assert.deepEqual(w.logs, []);
  });
});
