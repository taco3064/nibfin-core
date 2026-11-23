import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBlockedBy, readBlocking } from "./dependencies.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection } from "./fake-github.test.ts";
import { issue } from "./fixtures.test.ts";

const target = { owner: "acme", repo: "app", number: 1 };
const blockedBy = "GET /repos/acme/app/issues/1/dependencies/blocked_by";
const blocking = "GET /repos/acme/app/issues/1/dependencies/blocking";

describe("readBlockedBy", () => {
  it("reads every page, keeping each Issue's own repository", async () => {
    const upstream = Array.from({ length: 101 }, (_, index) =>
      issue(index + 2, { labels: ["scope"] }),
    );
    upstream.push(
      issue(9, {
        owner: "other",
        repo: "lib",
        state: "closed",
        labels: ["delivered", { name: "shaped" }],
      }),
    );
    const github = fakeGitHub({ [blockedBy]: paged(upstream) });
    const result = await readBlockedBy(github.client, target, 102);
    assert.equal(result.length, 102);
    assert.equal(github.calls.length, 2);
    assert.deepEqual(result.at(-1), {
      owner: "other",
      repo: "lib",
      number: 9,
      state: "closed",
      labels: ["delivered", "shaped"],
      url: "https://github.com/other/lib/issues/9",
    });
    assert.equal(result[0]?.state, "open");
  });

  it("fails instead of reporting fewer blockers than the summary counts", async () => {
    const github = fakeGitHub({ [blockedBy]: paged([issue(2)]) });
    const error = await rejection(readBlockedBy(github.client, target, 2));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.match(String((error.cause as Error).message), /Read 1 of 2/);
    assert.equal((await readBlockedBy(github.client, target)).length, 1);
  });

  it("fails when a cross-repository read is refused or a page fails", async () => {
    for (const route of [failure(404), failure(403), failure(500)]) {
      const github = fakeGitHub({ [blockedBy]: route });
      const error = await rejection(readBlockedBy(github.client, target));
      assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
    }
  });
});

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
