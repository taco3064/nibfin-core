import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeGitHub } from "./fake-github.test.ts";
import { readDefaultBranch, readRepoOwnerId } from "./workflow-dispatch.ts";

const runRepo = { owner: "acme", repo: "runner" };

describe("readRepoOwnerId", () => {
  it("returns owner.id from the repository read readDefaultBranch shares", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/runner": {
        data: { default_branch: "trunk", owner: { id: 31, login: "acme" } },
      },
    });
    assert.equal(await readRepoOwnerId(github.client, runRepo), 31);
    assert.equal(await readDefaultBranch(github.client, runRepo), "trunk");
    assert.equal(github.calls.length, 1);
  });
});
