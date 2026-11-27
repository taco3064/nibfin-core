import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newestMergeOf, readBaseCd, readBaseHeads } from "./base-cd.ts";
import { readCdRuns } from "./cd-runs.ts";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import {
  cdRun,
  issue,
  nibfinPushRun,
  nibfinPushWorkflowId,
  pull,
  workflowRun,
} from "./fixtures.test.ts";

const headsPath = `GET /repos/acme/app/actions/workflows/${nibfinPushWorkflowId}/runs`;

interface Setup {
  /** Push runs of every workflow on `main`. */
  runs: unknown[];
  /** Pull requests by head branch. */
  pulls?: Record<string, unknown[]>;
  /** Pull requests GitHub associates with a commit, by SHA. */
  commitPulls?: Record<string, unknown[]>;
  issueState?: "open" | "closed";
}

function scenario(setup: Setup) {
  const github = fakeGitHub({
    "GET /repos/acme/app/actions/runs": (request) => {
      const sha = request.query.get("head_sha");
      const runs = setup.runs.filter(
        (run) => (run as { head_sha: string }).head_sha === sha,
      );
      return paged(runs, "workflow_runs")(request);
    },
    [headsPath]: (request) =>
      paged(
        setup.runs.filter(
          (run) => (run as { workflow_id?: number }).workflow_id === nibfinPushWorkflowId,
        ),
        "workflow_runs",
      )(request),
    "GET /repos/acme/app/issues/2": {
      data: issue(2, { state: setup.issueState ?? "open", labels: ["scope"] }),
    },
    "GET /repos/acme/app/issues/2/dependencies/blocked_by": paged([]),
    "GET /repos/acme/app/issues/2/comments": paged([]),
    "GET /repos/acme/app/pulls": (request) => {
      const head = request.query.get("head")?.replace("acme:", "") ?? "";
      return paged(setup.pulls?.[head] ?? [])(request);
    },
  });
  for (const [sha, pulls] of Object.entries(setup.commitPulls ?? {})) {
    github.routes.set(`GET /repos/acme/app/commits/${sha}/pulls`, paged(pulls));
  }
  return github;
}

/** A push head: Nibfin's run and one CD run of `workflow`. */
function head(id: number, sha: string, conclusion: string | null, workflow = "CI") {
  return [nibfinPushRun(id, sha), cdRun(id + 1, sha, workflow, conclusion)];
}

const ofIssue = (number: number, sha: string, branch = `nibfin/issue-${number}`) => [
  pull(number * 10, { head: branch, merged: true, mergeSha: sha }),
];

describe("readBaseHeads", () => {
  it("lists Nibfin's push workflow runs, newest first, one SHA per run", async () => {
    const github = scenario({
      runs: [
        nibfinPushRun(3, "m3"),
        nibfinPushRun(9, "m9"),
        nibfinPushRun(5, "m5"),
        nibfinPushRun(10, "m9"),
        workflowRun(11, {
          sha: "x",
          event: "workflow_dispatch",
          workflowId: nibfinPushWorkflowId,
        }),
        workflowRun(12, { sha: "y", branch: "other", workflowId: nibfinPushWorkflowId }),
        cdRun(13, "m3", "CI"),
      ],
    });
    const heads = await readBaseHeads(github.client, repo, "main", nibfinPushWorkflowId);
    assert.deepEqual(heads, ["m9", "m5", "m3"]);
    const [call] = github.calls;
    assert.equal(call.path, headsPath.slice("GET ".length));
    assert.equal(call.query.get("event"), "push");
    assert.equal(call.query.get("branch"), "main");
    assert.equal(call.query.get("per_page"), "100");
    assert.equal(call.query.get("page"), null);
  });

  it("other workflows' push runs take no slot of the page", async () => {
    const runs = Array.from({ length: 100 }, (_, index) => [
      nibfinPushRun(index * 10 + 1, `m${index}`),
      ...["A", "B", "C"].map((name, at) => cdRun(index * 10 + 2 + at, `m${index}`, name)),
    ]).flat();
    const github = scenario({ runs });
    const heads = await readBaseHeads(github.client, repo, "main", nibfinPushWorkflowId);
    assert.equal(heads.length, 100);
    assert.equal(heads[0], "m99");
    assert.equal(heads.at(-1), "m0");
  });

  it("fails as a read when GitHub fails", async () => {
    const github = fakeGitHub({ [headsPath]: failure(500) });
    const error = await rejection(
      readBaseHeads(github.client, repo, "main", nibfinPushWorkflowId),
    );
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("newestMergeOf", () => {
  it("names the merge of the newest merged pull request", async () => {
    const github = scenario({
      runs: [],
      issueState: "closed",
      pulls: {
        "nibfin/issue-2": [pull(11, { head: "nibfin/issue-2", merged: true })],
        "nibfin/issue-2-cd-1": [
          pull(14, { head: "nibfin/issue-2-cd-1", state: "open" }),
          pull(12, { head: "nibfin/issue-2-cd-1", merged: true, mergeSha: "f12" }),
        ],
      },
    });
    assert.deepEqual(await newestMergeOf(github.client, repo, 2), {
      number: 2,
      open: false,
      merge: { sha: "f12", pullRequestUrl: "https://github.com/acme/app/pull/12" },
    });
  });

  it("has no merge without a merged pull request", async () => {
    const github = scenario({ runs: [] });
    assert.deepEqual(await newestMergeOf(github.client, repo, 2), {
      number: 2,
      open: true,
      merge: null,
    });
  });
});

describe("readBaseCd", () => {
  async function baseCd(setup: Setup, merge: string, issueNumber = 1) {
    const github = scenario(setup);
    const own = await readCdRuns(github.client, repo, "main", merge);
    return {
      github,
      base: await readBaseCd(github.client, repo, "main", own, issueNumber),
    };
  }

  it("is null without Nibfin's workflow id", async () => {
    const runs = [workflowRun(1, { name: "Nibfin · x", sha: "m1" })];
    const { base, github } = await baseCd({ runs }, "m1");
    assert.equal(base, null);
    assert.equal(github.calls.length, 1);
  });

  it("knows nothing around a merge that is not on the page", async () => {
    // GitHub answers M's runs, but M is past the page of push heads.
    const off = { ...nibfinPushRun(1, "m1"), head_branch: "gone" };
    const runs = [off, ...head(3, "m2", "success"), nibfinPushRun(5, "x")];
    const { base } = await baseCd({ runs }, "m1");
    assert.deepEqual(base, {
      heads: ["x", "m2"],
      newest: null,
      previous: null,
      previousIssue: null,
    });
  });

  it("reads no newest head or predecessor for a lone merge", async () => {
    const { base } = await baseCd({ runs: head(1, "m1", "failure") }, "m1");
    assert.deepEqual(base, {
      heads: ["m1"],
      newest: null,
      previous: null,
      previousIssue: null,
    });
  });

  it("reads the newest head and a green predecessor, and no Issue", async () => {
    const runs = [
      ...head(1, "m0", "success"),
      ...head(3, "m1", "failure"),
      ...head(5, "m2", null),
    ];
    const { base, github } = await baseCd({ runs }, "m1");
    assert.deepEqual(base?.heads, ["m2", "m1", "m0"]);
    assert.equal(base?.newest?.mergeCommitSha, "m2");
    assert.equal(base?.previous?.mergeCommitSha, "m0");
    assert.equal(base?.previousIssue, null);
    assert.ok(!github.calls.some((call) => call.path.endsWith("/pulls")));
  });

  it("has no previous Issue for a red push of no Issue", async () => {
    const runs = [...head(1, "m0", "failure"), ...head(3, "m1", "failure")];
    const { base } = await baseCd({ runs, commitPulls: { m0: [] } }, "m1");
    assert.equal(base?.previous?.mergeCommitSha, "m0");
    assert.equal(base?.previousIssue, null);
  });

  it("names the Issue itself without reading it again", async () => {
    const runs = [...head(1, "m0", "failure"), ...head(3, "m1", "failure")];
    const commitPulls = { m0: ofIssue(1, "m0") };
    const { base, github } = await baseCd({ runs, commitPulls }, "m1");
    assert.deepEqual(base?.previousIssue, { number: 1, open: true, fix: null });
    assert.ok(!github.calls.some((call) => call.path === "/graphql"));
  });

  it("has no fix while the previous Issue's newest merge is the red push", async () => {
    const runs = [...head(1, "m0", "failure"), ...head(3, "m1", "failure")];
    const pulls = { "nibfin/issue-2": ofIssue(2, "m0") };
    const commitPulls = { m0: ofIssue(2, "m0") };
    const { base } = await baseCd(
      { runs, pulls, commitPulls, issueState: "closed" },
      "m1",
    );
    assert.deepEqual(base?.previousIssue, { number: 2, open: false, fix: null });
  });

  it("has no fix when the previous Issue merged nothing", async () => {
    const runs = [...head(1, "m0", "failure"), ...head(3, "m1", "failure")];
    const open = [pull(20, { head: "nibfin/issue-2", sha: "m0" })];
    const { base } = await baseCd({ runs, commitPulls: { m0: open } }, "m1");
    assert.deepEqual(base?.previousIssue, { number: 2, open: true, fix: null });
  });

  it("reads the previous Issue's fix and whether it is newer", async () => {
    const runs = [
      ...head(1, "m0", "failure"),
      ...head(3, "m1", "failure"),
      ...head(5, "f2", "success"),
    ];
    const fixBranch = "nibfin/issue-2-cd-1";
    const pulls = {
      "nibfin/issue-2": ofIssue(2, "m0"),
      [fixBranch]: [pull(21, { head: fixBranch, merged: true, mergeSha: "f2" })],
    };
    const commitPulls = { m0: ofIssue(2, "m0") };
    const { base } = await baseCd({ runs, pulls, commitPulls }, "m1");
    const fix = base?.previousIssue?.fix;
    assert.equal(base?.previousIssue?.number, 2);
    assert.equal(fix?.mergeCommitSha, "f2");
    assert.equal(fix?.pullRequestUrl, "https://github.com/acme/app/pull/21");
    assert.equal(fix?.newerThanMerge, true);
    assert.equal(fix?.cd.runs[0]?.state, "success");
    // The fix is not on the page yet: not newer than the merge.
    const early = runs.slice(0, 4);
    const second = await baseCd({ runs: early, pulls, commitPulls }, "m1");
    assert.equal(second.base?.previousIssue?.fix?.newerThanMerge, false);
  });
});
