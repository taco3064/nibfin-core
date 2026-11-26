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
} from "./fake-github.test.ts";
import {
  checkRun,
  issue,
  type IssueOptions,
  pull,
  workflowRun,
} from "./fixtures.test.ts";
import { readIssueSnapshot } from "./snapshot.ts";
import { deriveStage } from "./stage.ts";

const assignee = { id: 5, login: "taco" };

interface Scenario {
  issue?: IssueOptions;
  blockedBy?: unknown[];
  pulls?: Record<string, unknown[]>;
  refs?: string[];
  checkRuns?: Record<string, unknown[]>;
  runs?: unknown[];
}

function scenario(setup: Scenario): FakeGitHub {
  const github = fakeGitHub({
    "GET /repos/acme/app/issues/1": {
      data: issue(1, {
        labels: ["scope", "shaped"],
        assignees: [assignee],
        ...setup.issue,
      }),
    },
    "GET /repos/acme/app/issues/1/dependencies/blocked_by": paged(setup.blockedBy ?? []),
    "GET /repos/acme/app/pulls": (request) => {
      const head = request.query.get("head")?.replace("acme:", "") ?? "";
      return paged(setup.pulls?.[head] ?? [])(request);
    },
    "GET /repos/acme/app/rules/branches/main": paged([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "verify", integration_id: 15368 }],
        },
      },
    ]),
    "GET /repos/acme/app/actions/runs": (request) => {
      const sha = request.query.get("head_sha");
      const event = request.query.get("event");
      const runs = (setup.runs ?? []).filter(
        (run) =>
          (run as { head_sha: string }).head_sha === sha &&
          (event === null || (run as { event: string }).event === event),
      );
      return paged(runs, "workflow_runs")(request);
    },
  });
  for (const ref of setup.refs ?? []) {
    github.routes.set(`GET /repos/acme/app/git/ref/heads/${ref}`, { data: { ref } });
  }
  for (const [sha, runs] of Object.entries(setup.checkRuns ?? {})) {
    github.routes.set(
      `GET /repos/acme/app/commits/${sha}/check-runs`,
      paged(runs, "check_runs"),
    );
    github.routes.set(`GET /repos/acme/app/commits/${sha}/statuses`, paged([]));
  }
  return github;
}

const fixHead = "nibfin/issue-1-cd-1";

/** A pull request summary as `readPullRequest` returns it. */
function snapshotPull(number: number) {
  return {
    number,
    state: "open" as const,
    merged: false,
    headRef: "nibfin/issue-1",
    headSha: `head-${number}`,
    baseRef: "main",
    mergeCommitSha: null,
    url: "",
  };
}

describe("readIssueSnapshot", () => {
  it("reads the Issue, blockers, branches, CI of open and CD of merged PRs", async () => {
    const github = scenario({
      issue: { totalBlockedBy: 1, stateReason: "reopened" },
      blockedBy: [
        issue(7, { owner: "other", repo: "lib", state: "closed", labels: ["delivered"] }),
      ],
      pulls: {
        "nibfin/issue-1": [pull(10, { merged: true, mergeSha: "m10" })],
        [fixHead]: [pull(11, { head: fixHead, sha: "h11" })],
      },
      checkRuns: { h11: [checkRun(1, "verify", { conclusion: "failure" })] },
      runs: [workflowRun(1, { sha: "m10", conclusion: "failure" })],
    });
    const snapshot = await readIssueSnapshot(github.client, repo, 1);
    assert.deepEqual(snapshot.issue, {
      owner: "acme",
      repo: "app",
      number: 1,
      state: "open",
      stateReason: "reopened",
      labels: ["scope", "shaped"],
      assignees: [assignee],
      url: "https://github.com/acme/app/issues/1",
    });
    assert.deepEqual(
      snapshot.blockedBy.map((dependency) => [dependency.repo, dependency.state]),
      [["lib", "closed"]],
    );
    assert.deepEqual(
      snapshot.pullRequests.map((pr) => pr.number),
      [11, 10],
    );
    const [fix, delivery] = snapshot.pullRequests;
    assert.equal(fix?.ci?.results[0]?.state, "failed");
    assert.equal(fix?.cd, null);
    assert.equal(delivery?.ci, null);
    assert.equal(delivery?.cd?.runs[0]?.state, "failed");
    assert.equal(snapshot.branches.current.name, fixHead);
    assert.equal(snapshot.branches.current, snapshot.branches.fixes[0]);
    assert.equal(snapshot.branches.nextFixBranch, "nibfin/issue-1-cd-2");
    assert.deepEqual(deriveStage(snapshot).stage, "ci-failed");
  });

  it("defaults missing fields and skips CD without a merge sha", async () => {
    const github = scenario({
      issue: { state: "closed", assignees: undefined },
      pulls: { "nibfin/issue-1": [pull(3, { merged: true, mergeSha: null })] },
    });
    const snapshot = await readIssueSnapshot(github.client, repo, 1);
    assert.equal(snapshot.issue.state, "closed");
    assert.equal(snapshot.issue.stateReason, null);
    assert.deepEqual(snapshot.issue.assignees, []);
    assert.equal(snapshot.pullRequests[0]?.cd, null);
  });

  it("derives the stage from GitHub data, before and after Nibfin's run", async () => {
    const pulls = { "nibfin/issue-1": [pull(4, { merged: true, mergeSha: "m4" })] };
    const before = scenario({ pulls, runs: [workflowRun(1, { sha: "m4" })] });
    const waiting = deriveStage(await readIssueSnapshot(before.client, repo, 1));
    assert.deepEqual(
      [waiting.stage, "reason" in waiting ? waiting.reason : undefined],
      ["awaiting-cd", "nibfin-push-run-missing"],
    );
    const after = scenario({
      pulls,
      runs: [
        workflowRun(1, { sha: "m4" }),
        workflowRun(2, { sha: "m4", name: "Nibfin · events", path: "n.yml" }),
      ],
    });
    assert.equal(
      deriveStage(await readIssueSnapshot(after.client, repo, 1)).stage,
      "done",
    );
  });

  it("fails for a pull request number", async () => {
    const github = scenario({ issue: { pullRequest: true } });
    const error = await rejection(readIssueSnapshot(github.client, repo, 1));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });

  it("fails as a whole when any read fails, never partially", async () => {
    const routes = [
      "GET /repos/acme/app/issues/1",
      "GET /repos/acme/app/issues/1/dependencies/blocked_by",
      "GET /repos/acme/app/pulls",
      "GET /repos/acme/app/commits/h11/check-runs",
      "GET /repos/acme/app/actions/runs",
      "GET /repos/acme/app/pulls/11",
    ];
    for (const route of routes) {
      const github = scenario({
        pulls: {
          "nibfin/issue-1": [pull(10, { merged: true, mergeSha: "m10" })],
          [fixHead]: [pull(11, { head: fixHead, sha: "h11" })],
        },
        checkRuns: { h11: [] },
      });
      github.routes.set(route, failure(500));
      const error = await rejection(readIssueSnapshot(github.client, repo, 1));
      assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED", route);
    }
  });

  it("uses replacement CI and CD readers when given", async () => {
    const github = scenario({
      pulls: {
        "nibfin/issue-1": [pull(10, { merged: true, mergeSha: "m10" })],
        [fixHead]: [pull(11, { head: fixHead, sha: "h11" })],
      },
    });
    const ci = { requiredChecks: [], results: [] };
    const cd = { mergeCommitSha: "m10", nibfinRunPresent: true, runs: [] };
    const snapshot = await readIssueSnapshot(github.client, repo, 1, {
      readCi: () => Promise.resolve(ci),
      readCdRuns: () => Promise.resolve(cd),
    });
    assert.deepEqual(
      snapshot.pullRequests.map((pr) => [pr.ci, pr.cd]),
      [
        [ci, null],
        [null, cd],
      ],
    );
    assert.equal(deriveStage(snapshot).stage, "review");
  });

  it("reads mergeable of the current branch's open PR only", async () => {
    const github = scenario({
      pulls: {
        "nibfin/issue-1": [pull(10)],
        [fixHead]: [pull(11, { head: fixHead, sha: "h11" })],
      },
      checkRuns: { h11: [], "head-10": [] },
    });
    github.routes.set("GET /repos/acme/app/pulls/11", {
      data: { ...pull(11, { head: fixHead, sha: "h11" }), mergeable: false },
    });
    const snapshot = await readIssueSnapshot(github.client, repo, 1);
    assert.deepEqual(
      snapshot.pullRequests.map((pr) => [pr.number, pr.mergeable]),
      [
        [11, false],
        [10, null],
      ],
    );
    const reads = github.calls.filter((call) => /\/pulls\/\d+$/.test(call.path));
    assert.deepEqual(
      reads.map((call) => call.path),
      ["/repos/acme/app/pulls/11"],
    );
    const stage = deriveStage(snapshot);
    assert.equal(stage.stage, "conflict");
    assert.equal("pullRequest" in stage && stage.pullRequest.number, 11);
  });

  it("keeps the CI rules while GitHub computes mergeable", async () => {
    const github = scenario({
      pulls: { "nibfin/issue-1": [pull(10)] },
      checkRuns: { "head-10": [] },
    });
    const snapshot = await readIssueSnapshot(github.client, repo, 1, {
      readPullRequest: (_client, _repo, number) =>
        Promise.resolve({
          ...snapshotPull(number),
          mergeable: null,
          mergeableState: "unknown",
          baseSha: "b".repeat(40),
        }),
    });
    assert.equal(snapshot.pullRequests[0]?.mergeable, null);
    assert.equal(deriveStage(snapshot).stage, "awaiting-ci");
  });
});
