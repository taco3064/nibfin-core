import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, rejection } from "./fake-github.test.ts";
import { readIssueText } from "./issue-text.ts";

const target = { owner: "other", repo: "lib", number: 3 };
const route = "GET /repos/other/lib/issues/3";

describe("readIssueText", () => {
  it("returns the title and body", async () => {
    const github = fakeGitHub({ [route]: { data: { title: "T", body: "B" } } });
    assert.deepEqual(await readIssueText(github.client, target), {
      title: "T",
      body: "B",
    });
  });

  it("gives an Issue without a description the empty body", async () => {
    const github = fakeGitHub({ [route]: { data: { title: "T", body: null } } });
    assert.deepEqual(await readIssueText(github.client, target), {
      title: "T",
      body: "",
    });
  });

  it("fails as a read failure", async () => {
    const github = fakeGitHub({ [route]: failure(500) });
    const error = await rejection(readIssueText(github.client, target));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(error.operation, "read text of other/lib#3");
  });
});
