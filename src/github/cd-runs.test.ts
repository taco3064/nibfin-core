import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCdRuns } from "./cd-runs.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import { workflowRun } from "./fixtures.test.ts";

const runs = "GET /repos/acme/app/actions/runs";

describe("readCdRuns", () => {
  it("queries push runs of the merge commit on the base branch", async () => {
    const github = fakeGitHub({ [runs]: paged([], "workflow_runs") });
    const cd = await readCdRuns(github.client, repo, "main", "merge-1");
    assert.deepEqual(cd, {
      mergeCommitSha: "merge-1",
      nibfinRunPresent: false,
      runs: [],
    });
    const query = github.calls[0]?.query;
    assert.equal(query?.get("event"), "push");
    assert.equal(query?.get("branch"), "main");
    assert.equal(query?.get("head_sha"), "merge-1");
    assert.equal(query?.get("per_page"), "100");
  });

  it("splits Nibfin's runs from the CD set, newest run per workflow path", async () => {
    const github = fakeGitHub({
      [runs]: paged(
        [
          workflowRun(1, { path: ".github/workflows/ci.yml", conclusion: "failure" }),
          workflowRun(3, { path: ".github/workflows/ci.yml", conclusion: "success" }),
          workflowRun(2, { path: ".github/workflows/ci.yml", conclusion: "failure" }),
          workflowRun(4, {
            name: null,
            path: ".github/workflows/deploy.yml",
            status: "in_progress",
            conclusion: null,
          }),
          workflowRun(5, {
            name: "Nibfin · events",
            path: ".github/workflows/nibfin.yml",
          }),
          workflowRun(6, { event: "workflow_dispatch", path: ".github/workflows/x.yml" }),
          workflowRun(7, { sha: "other", path: ".github/workflows/y.yml" }),
        ],
        "workflow_runs",
      ),
    });
    const cd = await readCdRuns(github.client, repo, "main", "merge-1");
    assert.equal(cd.nibfinRunPresent, true);
    assert.deepEqual(cd.runs, [
      {
        id: 3,
        name: "CI",
        path: ".github/workflows/ci.yml",
        status: "completed",
        conclusion: "success",
        state: "success",
        url: "https://github.com/acme/app/actions/runs/3",
      },
      {
        id: 4,
        name: "",
        path: ".github/workflows/deploy.yml",
        status: "in_progress",
        conclusion: null,
        state: "pending",
        url: "https://github.com/acme/app/actions/runs/4",
      },
    ]);
  });

  it("reads every page and fails when one fails", async () => {
    const items = Array.from({ length: 130 }, (_, index) =>
      workflowRun(index + 1, { path: `.github/workflows/w${index}.yml` }),
    );
    const github = fakeGitHub({ [runs]: paged(items, "workflow_runs") });
    const cd = await readCdRuns(github.client, repo, "main", "merge-1");
    assert.equal(cd.runs.length, 130);
    const broken = fakeGitHub({ [runs]: failure(500) });
    const error = await rejection(readCdRuns(broken.client, repo, "main", "merge-1"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });

  it("keeps the workflow id of Nibfin's push workflow", async () => {
    const nibfin = (id: number, path: string, workflowId?: number) =>
      workflowRun(id, { name: "Nibfin · x", path, workflowId });
    const idOf = async (items: unknown[]) => {
      const github = fakeGitHub({ [runs]: paged(items, "workflow_runs") });
      return (await readCdRuns(github.client, repo, "main", "merge-1")).nibfinWorkflowId;
    };
    const push = ".github/workflows/nibfin-issue.yml";
    assert.equal(
      await idOf([nibfin(1, ".github/workflows/a.yml", 3), nibfin(2, push, 9)]),
      9,
    );
    assert.equal(
      await idOf([
        nibfin(1, ".github/workflows/a.yml", 8),
        nibfin(2, ".github/workflows/b.yml", 4),
        nibfin(3, push),
      ]),
      4,
    );
    assert.equal(await idOf([nibfin(1, push)]), undefined);
    assert.equal(await idOf([workflowRun(1, { workflowId: 5 })]), undefined);
  });
});
