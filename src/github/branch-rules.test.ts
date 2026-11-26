import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBranchRules } from "./branch-rules.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";

const rules = "GET /repos/acme/app/rules/branches/main";
const planGated =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

describe("readBranchRules", () => {
  it("returns the rules of the branch, 100 per page", async () => {
    const github = fakeGitHub({ [rules]: paged([{ type: "deletion" }]) });
    assert.deepEqual(await readBranchRules(github.client, repo, "main"), [
      { type: "deletion" },
    ]);
    assert.equal(github.calls[0]?.query.get("per_page"), "100");
  });

  it("reads a private repository whose plan has no rulesets as no rules", async () => {
    const github = fakeGitHub({ [rules]: failure(403, planGated) });
    assert.deepEqual(await readBranchRules(github.client, repo, "main"), []);
  });

  it("fails on any other error", async () => {
    for (const response of [
      failure(403, "Resource not accessible by integration"),
      failure(404, planGated),
      failure(500),
      { status: 403, data: {} },
    ]) {
      const github = fakeGitHub({ [rules]: response });
      const error = await rejection(readBranchRules(github.client, repo, "main"));
      assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
      assert.match((error as Error).message, /read rules of acme\/app@main/);
    }
  });

  it("fails without a response", async () => {
    const github = fakeGitHub({
      [rules]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await rejection(readBranchRules(github.client, repo, "main"));
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
  });
});
