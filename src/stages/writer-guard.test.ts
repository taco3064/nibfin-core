import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, fakeGitHub, paged, rejection } from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import { StageError } from "./errors.ts";
import { jobContext } from "./fake-job.test.ts";
import { deliverRunName, requireNoOtherWriter } from "./writer-guard.ts";

const runs = "GET /repos/acme/runner/actions/runs";
const name = "Nibfin · acme/app#1 · deliver";
const context = {
  ...jobContext("/workspace"),
  runRepo: { owner: "acme", repo: "runner" },
  runId: 100,
};

function run(id: number, title: string, status = "in_progress", field = "display_title") {
  return {
    id,
    status,
    name: field === "name" ? title : "Nibfin · deliver",
    display_title: field === "name" ? "other" : title,
    html_url: `https://github.com/acme/runner/actions/runs/${id}`,
  };
}

describe("requireNoOtherWriter", () => {
  it("names the Deliver run of an Issue", () => {
    assert.equal(deliverRunName({ owner: "acme", repo: "app" }, 1), name);
  });

  it("passes when only this Job or other Issues are running", async () => {
    const github = fakeGitHub({
      [runs]: paged(
        [
          run(100, name),
          run(101, "Nibfin · acme/app#10 · deliver"),
          run(102, "Nibfin · acme/app#1 · shape"),
          run(103, name, "queued"),
        ],
        "workflow_runs",
      ),
    });
    await requireNoOtherWriter(github.client, context);
    const query = github.calls[0].query;
    assert.equal(query.get("status"), "in_progress");
    assert.equal(query.get("per_page"), "100");
  });

  for (const field of ["display_title", "name"]) {
    it(`stays Pending while another Writer runs (by ${field})`, async () => {
      const others = Array.from({ length: 120 }, (_, index) => run(200 + index, "x"));
      const github = fakeGitHub({
        [runs]: paged([...others, run(7, name, "in_progress", field)], "workflow_runs"),
      });
      const error = await rejection(requireNoOtherWriter(github.client, context));
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_WRITER_ACTIVE");
      assert.match(error.message, /actions\/runs\/7\)/);
      assert.deepEqual(github.writes(), []);
    });
  }

  it("fails when the runs cannot be read", async () => {
    const github = fakeGitHub({ [runs]: failure(500) });
    const error = await rejection(requireNoOtherWriter(github.client, context));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });

  for (const [field, missing] of [
    ["NIBFIN_RUN_REPO", { runRepo: undefined }],
    ["NIBFIN_RUN_ID", { runId: undefined }],
  ] as const) {
    it(`needs ${field}`, async () => {
      const github = fakeGitHub();
      const error = await rejection(
        requireNoOtherWriter(github.client, { ...context, ...missing }),
      );
      assert.equal((error as StageError).code, "STAGE_INPUT_INVALID");
      assert.equal((error as StageError).message, `${field} is missing`);
    });
  }
});
