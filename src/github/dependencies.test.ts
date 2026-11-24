import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBlocking } from "./dependencies.ts";
import { GitHubError } from "./errors.ts";
import { fakeGitHub, paged, rejection } from "./fake-github.test.ts";
import { issue } from "./fixtures.test.ts";

const target = { owner: "acme", repo: "app", number: 1 };
const blocking = "GET /repos/acme/app/issues/1/dependencies/blocking";

describe("readBlocking", () => {
  it("reads the Issues this Issue blocks, checked against its summary", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/1": { data: issue(1, { totalBlocking: 2 }) },
      [blocking]: paged([issue(3), issue(4, { owner: "other", repo: "svc" })]),
    });
    const result = await readBlocking(github.client, target);
    assert.deepEqual(
      result.map(
        (dependency) => `${dependency.owner}/${dependency.repo}#${dependency.number}`,
      ),
      ["acme/app#3", "other/svc#4"],
    );
  });

  it("fails when the list is short or the Issue cannot be read", async () => {
    const short = fakeGitHub({
      "GET /repos/acme/app/issues/1": { data: issue(1, { totalBlocking: 3 }) },
      [blocking]: paged([issue(3)]),
    });
    const shortError = await rejection(readBlocking(short.client, target));
    assert.equal((shortError as GitHubError).code, "GITHUB_READ_FAILED");
    const missing = fakeGitHub({ [blocking]: paged([]) });
    const missingError = await rejection(readBlocking(missing.client, target));
    assert.equal((missingError as GitHubError).code, "GITHUB_READ_FAILED");
  });

  it("accepts an Issue without a dependency summary", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/1": { data: issue(1) },
      [blocking]: paged([issue(3)]),
    });
    assert.equal((await readBlocking(github.client, target)).length, 1);
  });
});
