import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import { readJobLog, readRunJobs } from "./job-logs.ts";

const jobs = "GET /repos/acme/app/actions/runs/7/jobs";
const log = "GET /repos/acme/app/actions/jobs/11/logs";

function job(id: number, conclusion: string | null, status = "completed") {
  return {
    id,
    name: `job ${id}`,
    status,
    conclusion,
    html_url: `https://github.com/acme/app/actions/runs/7/job/${id}`,
  };
}

describe("readRunJobs", () => {
  it("lists every job of the latest attempt with its state", async () => {
    const items = [job(1, "success"), job(2, "failure"), job(3, null, "in_progress")];
    const github = fakeGitHub({ [jobs]: paged(items, "jobs") });
    assert.deepEqual(await readRunJobs(github.client, repo, 7), [
      { id: 1, name: "job 1", state: "success", url: items[0]!.html_url },
      { id: 2, name: "job 2", state: "failed", url: items[1]!.html_url },
      { id: 3, name: "job 3", state: "pending", url: items[2]!.html_url },
    ]);
    assert.equal(github.calls[0]?.query.get("filter"), "latest");
  });

  it("fails when the jobs cannot be read", async () => {
    const github = fakeGitHub({ [jobs]: failure(500) });
    const error = await rejection(readRunJobs(github.client, repo, 7));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("readJobLog", () => {
  it("returns the log text", async () => {
    const github = fakeGitHub({ [log]: { data: "line 1\nline 2\n" } });
    assert.equal(await readJobLog(github.client, repo, 11), "line 1\nline 2\n");
  });

  it("decodes a binary log", async () => {
    const github = fakeGitHub({
      [log]: { data: "bytes", headers: { "content-type": "application/octet-stream" } },
    });
    // The fake encodes every body as JSON, so the bytes keep the quotes.
    assert.equal(await readJobLog(github.client, repo, 11), '"bytes"');
  });

  it("returns undefined when GitHub has no log", async () => {
    const github = fakeGitHub();
    assert.equal(await readJobLog(github.client, repo, 11), undefined);
  });

  it("fails on any other error", async () => {
    const github = fakeGitHub({ [log]: failure(403) });
    const error = await rejection(readJobLog(github.client, repo, 11));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});
