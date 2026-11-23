import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import {
  type FakeGitHub,
  failure,
  fakeGitHub,
  paged,
  rejection,
  repo,
  type Route,
} from "./fake-github.test.ts";
import { checkRun, commitStatus, workflowRun } from "./fixtures.test.ts";
import {
  readCi,
  readRequiredCheckResults,
  readRequiredChecks,
  type RequiredCheck,
} from "./required-checks.ts";

const rules = "GET /repos/acme/app/rules/branches/main";
const branch = "GET /repos/acme/app/branches/main";
const checkRuns = "GET /repos/acme/app/commits/abc/check-runs";
const statuses = "GET /repos/acme/app/commits/abc/statuses";
const runs = "GET /repos/acme/app/actions/runs";

const statusRule = (checks: Array<{ context: string; integration_id?: number }>) => ({
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: checks,
  },
});

const classic = (
  contexts: string[],
  checks: Array<{ context: string; app_id: number | null }>,
) => ({
  data: {
    name: "main",
    protection: { enabled: true, required_status_checks: { contexts, checks } },
  },
});

describe("readRequiredChecks", () => {
  it("combines rulesets and classic protection without duplicates", async () => {
    const github = fakeGitHub({
      [rules]: paged([
        { type: "deletion" },
        statusRule([{ context: "verify", integration_id: 15368 }, { context: "lint" }]),
        { type: "required_status_checks" },
      ]),
      [branch]: classic(
        ["verify", "legacy", "any-app"],
        [
          { context: "verify", app_id: 15368 },
          { context: "any-app", app_id: null },
          { context: "explicit-any", app_id: -1 },
        ],
      ),
    });
    const checks = await readRequiredChecks(github.client, repo, "main");
    assert.deepEqual(checks, [
      { context: "verify", integrationId: 15368 },
      { context: "lint", integrationId: null },
      { context: "any-app", integrationId: null },
      { context: "explicit-any", integrationId: null },
      { context: "legacy", integrationId: null },
    ]);
    assert.equal(github.calls[0]?.query.get("per_page"), "100");
  });

  it("returns no checks for an unprotected or missing branch", async () => {
    const unprotected = fakeGitHub({
      [rules]: paged([]),
      [branch]: { data: { name: "main" } },
    });
    assert.deepEqual(await readRequiredChecks(unprotected.client, repo, "main"), []);
    const partial = fakeGitHub({
      [rules]: paged([]),
      [branch]: { data: { protection: { required_status_checks: {} } } },
    });
    assert.deepEqual(await readRequiredChecks(partial.client, repo, "main"), []);
    const missing = fakeGitHub({ [rules]: paged([]) });
    assert.deepEqual(await readRequiredChecks(missing.client, repo, "main"), []);
  });

  it("fails when rulesets or the branch cannot be read", async () => {
    for (const routes of [
      { [rules]: failure(500) } as Record<string, Route>,
      { [rules]: paged([]), [branch]: failure(403) },
    ]) {
      const github = fakeGitHub(routes);
      const error = await rejection(readRequiredChecks(github.client, repo, "main"));
      assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
    }
  });
});

function resultsFake(
  runsData: unknown[],
  statusData: unknown[] = [],
  workflowRuns: unknown[] = [],
): FakeGitHub {
  return fakeGitHub({
    [checkRuns]: paged(runsData, "check_runs"),
    [statuses]: paged(statusData),
    [runs]: paged(workflowRuns, "workflow_runs"),
  });
}

const verify: RequiredCheck = { context: "verify", integrationId: 15368 };
const anySource: RequiredCheck = { context: "verify", integrationId: null };

describe("readRequiredCheckResults", () => {
  it("reads nothing when no checks are required", async () => {
    const github = resultsFake([]);
    assert.deepEqual(await readRequiredCheckResults(github.client, repo, [], "abc"), []);
    assert.equal(github.calls.length, 0);
  });

  it("matches check runs by context and app, newest first", async () => {
    const github = resultsFake([
      checkRun(1, "verify", { conclusion: "failure" }),
      checkRun(3, "verify", { conclusion: "success", slug: "github-actions" }),
      checkRun(2, "verify", { conclusion: "failure" }),
      checkRun(9, "verify", { appId: 1, conclusion: "failure" }),
      checkRun(10, "other", { conclusion: "failure" }),
    ]);
    const [result] = await readRequiredCheckResults(github.client, repo, [verify], "abc");
    assert.deepEqual(result, {
      ...verify,
      state: "success",
      source: "check-run",
      url: "https://github.com/acme/app/runs/3",
      checkRunId: 3,
      appSlug: "github-actions",
    });
    const query = github.calls.find((call) => call.path.endsWith("/actions/runs"))?.query;
    assert.equal(query?.get("head_sha"), "abc");
  });

  it("lets an any-source check match any app or a run without an app", async () => {
    const github = resultsFake([
      checkRun(4, "verify", { appId: null, status: "queued" }),
    ]);
    const [result] = await readRequiredCheckResults(
      github.client,
      repo,
      [anySource],
      "abc",
    );
    assert.equal(result?.state, "pending");
    assert.equal(result?.source, "check-run");
    assert.equal(result?.checkRunId, 4);
    assert.equal(result?.appSlug, null);
    const unnamed = resultsFake([checkRun(5, "verify")]);
    const [other] = await readRequiredCheckResults(
      unnamed.client,
      repo,
      [anySource],
      "abc",
    );
    assert.equal(other?.appSlug, null);
  });

  it("leaves a specific-app check pending when only other apps report", async () => {
    const github = resultsFake(
      [checkRun(4, "verify", { appId: 1 })],
      [commitStatus(1, "verify", "success")],
    );
    const [result] = await readRequiredCheckResults(github.client, repo, [verify], "abc");
    assert.deepEqual(result, { ...verify, state: "pending", source: "none", url: null });
  });

  it("uses the newest commit status per context for any-source checks", async () => {
    const github = resultsFake(
      [],
      [
        commitStatus(5, "verify", "pending"),
        commitStatus(7, "verify", "failure"),
        commitStatus(6, "verify", "success"),
        commitStatus(8, "lint", "success"),
      ],
    );
    const [result] = await readRequiredCheckResults(
      github.client,
      repo,
      [anySource],
      "abc",
    );
    assert.deepEqual(result, {
      ...anySource,
      state: "failed",
      source: "status",
      url: "https://ci.example/7",
    });
  });

  it("excludes check runs of Nibfin's own workflow runs", async () => {
    const github = resultsFake(
      [
        checkRun(8, "verify", { suiteId: 500, conclusion: "success" }),
        checkRun(2, "verify", { suiteId: 501, conclusion: "failure" }),
        checkRun(1, "verify", { suiteId: null, conclusion: "failure" }),
      ],
      [],
      [
        workflowRun(1, { name: "Nibfin · events", suiteId: 500 }),
        workflowRun(2, { name: "CI", suiteId: 501 }),
        workflowRun(3, { name: "Nibfin · other" }),
      ],
    );
    const [result] = await readRequiredCheckResults(github.client, repo, [verify], "abc");
    assert.equal(result?.state, "failed");
    assert.equal(result?.url, "https://github.com/acme/app/runs/2");
  });

  it("fails when any result list cannot be read", async () => {
    for (const broken of [checkRuns, statuses, runs]) {
      const github = resultsFake([checkRun(1, "verify")]);
      github.routes.set(broken, failure(500));
      const error = await rejection(
        readRequiredCheckResults(github.client, repo, [verify], "abc"),
      );
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    }
  });
});

describe("readCi", () => {
  it("reads the required checks of the base and their results on the head", async () => {
    const github = resultsFake([checkRun(1, "verify")]);
    github.routes.set(
      rules,
      paged([statusRule([{ context: "verify", integration_id: 15368 }])]),
    );
    const ci = await readCi(github.client, repo, "main", "abc");
    assert.deepEqual(ci.requiredChecks, [verify]);
    assert.equal(ci.results[0]?.state, "success");
  });
});
