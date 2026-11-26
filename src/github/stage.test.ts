import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowRunSummary } from "./cd-runs.ts";
import type { DependencyIssue } from "./dependencies.ts";
import type { RequiredCheck, RequiredCheckResult } from "./required-checks.ts";
import type { RunState } from "./run-state.ts";
import type { BranchState, IssueSnapshot, PullRequestState } from "./snapshot.ts";
import { deliveryOutcome, deriveStage, type Stage } from "./stage.ts";

const delivery = "nibfin/issue-1";
const verify: RequiredCheck = { context: "verify", integrationId: 15368 };
const lint: RequiredCheck = { context: "lint", integrationId: null };

function result(check: RequiredCheck, state: RunState): RequiredCheckResult {
  return { ...check, state, source: "check-run", url: null };
}

function run(id: number, state: RunState): WorkflowRunSummary {
  return {
    id,
    name: `W${id}`,
    path: `w${id}.yml`,
    status: null,
    conclusion: null,
    state,
    url: "",
  };
}

interface PrOptions {
  state?: "open" | "closed";
  merged?: boolean;
  head?: string;
  checks?: RequiredCheck[];
  results?: RequiredCheckResult[];
  ci?: null;
  nibfinRun?: boolean;
  runs?: WorkflowRunSummary[];
  cd?: null;
  mergeable?: boolean | null;
}

function pr(number: number, options: PrOptions = {}): PullRequestState {
  const merged = options.merged ?? false;
  const state = options.state ?? (merged ? "closed" : "open");
  return {
    number,
    state,
    merged,
    headRef: options.head ?? delivery,
    headSha: `h${number}`,
    baseRef: "main",
    mergeCommitSha: merged ? `m${number}` : null,
    url: "",
    ci:
      state === "open" && options.ci !== null
        ? { requiredChecks: options.checks ?? [], results: options.results ?? [] }
        : null,
    cd:
      merged && options.cd !== null
        ? {
            mergeCommitSha: `m${number}`,
            nibfinRunPresent: options.nibfinRun ?? true,
            runs: options.runs ?? [],
          }
        : null,
    mergeable: options.mergeable ?? null,
  };
}

function branch(name: string, pullRequests: PullRequestState[] = []): BranchState {
  return { name, exists: true, pullRequests };
}

interface SnapshotOptions {
  state?: "open" | "closed";
  labels?: string[];
  assignees?: number;
  blockedBy?: DependencyIssue[];
  delivery?: PullRequestState[];
  fixes?: BranchState[];
}

function snapshot(options: SnapshotOptions = {}): IssueSnapshot {
  const deliveryBranch = branch(delivery, options.delivery ?? []);
  const fixes = options.fixes ?? [];
  return {
    issue: {
      owner: "acme",
      repo: "app",
      number: 1,
      state: options.state ?? "open",
      stateReason: null,
      labels: options.labels ?? ["scope", "shaped"],
      assignees: Array.from({ length: options.assignees ?? 1 }, (_, id) => ({
        id,
        login: `u${id}`,
      })),
      url: "",
    },
    blockedBy: options.blockedBy ?? [],
    branches: {
      delivery: deliveryBranch,
      fixes,
      current: fixes.at(-1) ?? deliveryBranch,
      nextFixBranch: `${delivery}-cd-${fixes.length + 1}`,
    },
    pullRequests: [],
  };
}

function dependency(state: "open" | "closed", labels: string[] = []): DependencyIssue {
  return { owner: "other", repo: "lib", number: 9, state, labels, url: "" };
}

const stageOf = (stage: Stage) => [stage.stage, "reason" in stage ? stage.reason : null];

describe("deriveStage: eligibility", () => {
  it("checks closed, scope, pause, blockers and Assignees in that order", () => {
    const everything = {
      state: "closed" as const,
      labels: ["pause", "shaped"],
      assignees: 0,
      blockedBy: [dependency("open")],
    };
    assert.deepEqual(stageOf(deriveStage(snapshot(everything))), [
      "ineligible",
      "closed",
    ]);
    const open = { ...everything, state: "open" as const };
    assert.deepEqual(stageOf(deriveStage(snapshot(open))), ["ineligible", "no-scope"]);
    const scoped = { ...open, labels: ["scope", "pause", "pending"] };
    assert.deepEqual(stageOf(deriveStage(snapshot(scoped))), ["ineligible", "paused"]);
    const waiting = { ...scoped, labels: ["scope", "pending"] };
    assert.deepEqual(stageOf(deriveStage(snapshot(waiting))), ["ineligible", "pending"]);
    const active = { ...scoped, labels: ["scope"] };
    assert.deepEqual(stageOf(deriveStage(snapshot(active))), ["ineligible", "blocked"]);
    const free = { ...active, blockedBy: [] };
    assert.deepEqual(stageOf(deriveStage(snapshot(free))), ["ineligible", "no-assignee"]);
  });

  it("derives the same stage for several Assignees as for one (#739)", () => {
    const blockedBy = [dependency("open")];
    for (const [options, stage] of [
      [{ labels: ["scope"] }, ["shape", null]],
      [{ labels: ["scope"], blockedBy }, ["ineligible", "blocked"]],
      [{ labels: ["scope", "pending"] }, ["ineligible", "pending"]],
      [{ labels: ["scope", "pause"] }, ["ineligible", "paused"]],
      [{ labels: ["scope", "shaped"] }, ["deliver", null]],
    ] as const) {
      for (const assignees of [1, 2, 3]) {
        const derived = deriveStage(
          snapshot({ ...options, labels: [...options.labels], assignees }),
        );
        assert.deepEqual(stageOf(derived), stage);
      }
    }
  });

  it("holds an Issue with pending at any stage, including delivery", () => {
    const merged = [pr(1, { merged: true })];
    const held = snapshot({ labels: ["scope", "shaped", "pending"], delivery: merged });
    assert.deepEqual(stageOf(deriveStage(held)), ["ineligible", "pending"]);
    const unshaped = snapshot({ labels: ["scope", "pending"] });
    assert.deepEqual(stageOf(deriveStage(unshaped)), ["ineligible", "pending"]);
  });

  it("pauses an Issue in any unfinished stage, including delivery", () => {
    const merged = [pr(1, { merged: true })];
    const paused = snapshot({ labels: ["scope", "shaped", "pause"], delivery: merged });
    assert.deepEqual(stageOf(deriveStage(paused)), ["ineligible", "paused"]);
  });

  it("keeps blocking on an upstream closed without delivered", () => {
    for (const upstream of [
      dependency("closed"),
      dependency("closed", ["shaped"]),
      dependency("open", ["delivered"]),
    ]) {
      const stage = deriveStage(snapshot({ blockedBy: [upstream] }));
      assert.deepEqual(stage, {
        stage: "ineligible",
        reason: "blocked",
        blockers: [upstream],
      });
    }
  });

  it("treats an upstream that is Closed + delivered as resolved", () => {
    const resolved = dependency("closed", ["scope", "delivered"]);
    assert.equal(deriveStage(snapshot({ blockedBy: [resolved] })).stage, "deliver");
    const mixed = deriveStage(snapshot({ blockedBy: [resolved, dependency("open")] }));
    assert.equal("blockers" in mixed && mixed.blockers.length, 1);
  });

  it("asks for a Shape when shaped is missing", () => {
    assert.deepEqual(deriveStage(snapshot({ labels: ["scope"] })), { stage: "shape" });
  });
});

describe("deliveryOutcome: pull requests and CI", () => {
  it("delivers on the branch when there is no PR or only closed-unmerged ones", () => {
    assert.deepEqual(deliveryOutcome(snapshot()), { stage: "deliver", branch: delivery });
    const closed = snapshot({ delivery: [pr(2, { state: "closed" })] });
    assert.deepEqual(deliveryOutcome(closed), { stage: "deliver", branch: delivery });
  });

  it("ignores labels and Issue state", () => {
    const closed = snapshot({ state: "closed", labels: [] });
    assert.equal(deliveryOutcome(closed).stage, "deliver");
  });

  it("goes to review when no checks are required", () => {
    const outcome = deliveryOutcome(snapshot({ delivery: [pr(2)] }));
    assert.equal(outcome.stage, "review");
    assert.ok("requiredChecks" in outcome);
    assert.deepEqual(outcome.requiredChecks, []);
  });

  it("waits for CI when the PR has no CI data", () => {
    const outcome = deliveryOutcome(snapshot({ delivery: [pr(2, { ci: null })] }));
    assert.equal(outcome.stage, "awaiting-ci");
  });

  it("derives conflict for an open PR that is not mergeable, before CI", () => {
    const failed = [result(verify, "failed")];
    const open = pr(2, { checks: [verify], results: failed, mergeable: false });
    const outcome = deliveryOutcome(snapshot({ delivery: [open] }));
    assert.deepEqual(outcome, { stage: "conflict", branch: delivery, pullRequest: open });
    const pending = pr(2, { checks: [verify], results: failed, mergeable: null });
    assert.equal(deliveryOutcome(snapshot({ delivery: [pending] })).stage, "ci-failed");
    const clean = pr(2, { mergeable: true });
    assert.equal(deliveryOutcome(snapshot({ delivery: [clean] })).stage, "review");
  });

  it("applies the CI rules, failure winning over pending", () => {
    const cases: Array<[RequiredCheckResult[], string]> = [
      [[result(verify, "failed"), result(lint, "pending")], "ci-failed"],
      [[result(verify, "success"), result(lint, "pending")], "awaiting-ci"],
      [[result(verify, "success")], "awaiting-ci"],
      [[result(verify, "success"), result(lint, "success")], "review"],
      [
        [{ ...result(verify, "success"), integrationId: 1 }, result(lint, "success")],
        "awaiting-ci",
      ],
    ];
    for (const [results, expected] of cases) {
      const open = pr(2, { checks: [verify, lint], results });
      const outcome = deliveryOutcome(snapshot({ delivery: [open] }));
      assert.equal(outcome.stage, expected);
      assert.ok("requiredChecks" in outcome);
      assert.deepEqual(outcome.requiredChecks, [verify, lint]);
      assert.equal(outcome.pullRequest, open);
    }
  });

  it("prefers the newest open PR over a merged one", () => {
    const outcome = deliveryOutcome(
      snapshot({ delivery: [pr(3), pr(2, { merged: true })] }),
    );
    assert.equal(outcome.stage, "review");
    assert.equal("pullRequest" in outcome && outcome.pullRequest.number, 3);
  });
});

describe("deliveryOutcome: CD", () => {
  const merged = (options: PrOptions) =>
    deliveryOutcome(snapshot({ delivery: [pr(2, { merged: true, ...options })] }));

  it("waits for Nibfin's own push run before judging the CD set", () => {
    for (const options of [
      { nibfinRun: false, runs: [run(1, "success")] },
      { cd: null },
    ]) {
      assert.deepEqual(stageOf(merged(options)), [
        "awaiting-cd",
        "nibfin-push-run-missing",
      ]);
    }
  });

  it("applies the CD rules after Nibfin's run, failure winning over pending", () => {
    const failed = merged({ runs: [run(1, "pending"), run(2, "failed")] });
    assert.equal(failed.stage, "cd-failed");
    assert.ok(failed.stage === "cd-failed");
    assert.equal(failed.nextFixBranch, `${delivery}-cd-1`);
    assert.equal(failed.runs.length, 2);
    const pending = merged({ runs: [run(1, "pending"), run(2, "success")] });
    assert.deepEqual(stageOf(pending), ["awaiting-cd", "cd-runs-pending"]);
    assert.equal(merged({ runs: [run(1, "success")] }).stage, "done");
    assert.equal(merged({ runs: [] }).stage, "done");
  });

  it("uses the merged PR when a newer PR on the branch was closed unmerged", () => {
    const outcome = deliveryOutcome(
      snapshot({ delivery: [pr(3, { state: "closed" }), pr(2, { merged: true })] }),
    );
    assert.equal(outcome.stage, "done");
  });

  it("derives done for an open Issue already labelled delivered", () => {
    const labels = ["scope", "shaped", "delivered"];
    const stage = deriveStage(snapshot({ labels, delivery: [pr(2, { merged: true })] }));
    assert.equal(stage.stage, "done");
  });
});

describe("deliveryOutcome: fixes after a CD failure", () => {
  const failedDelivery = [pr(2, { merged: true, runs: [run(1, "failed")] })];
  const fix = (pulls: PullRequestState[], k = 1) => branch(`${delivery}-cd-${k}`, pulls);

  it("delivers on the current fix branch before it has a PR", () => {
    const outcome = deliveryOutcome(
      snapshot({ delivery: failedDelivery, fixes: [fix([])] }),
    );
    assert.deepEqual(outcome, { stage: "deliver", branch: `${delivery}-cd-1` });
    const closed = fix([pr(3, { state: "closed", head: `${delivery}-cd-1` })]);
    const again = deliveryOutcome(
      snapshot({ delivery: failedDelivery, fixes: [closed] }),
    );
    assert.deepEqual(again, { stage: "deliver", branch: `${delivery}-cd-1` });
  });

  it("follows the fix PR's CI while it is open", () => {
    const open = pr(3, { head: `${delivery}-cd-1`, checks: [verify] });
    const outcome = deliveryOutcome(
      snapshot({ delivery: failedDelivery, fixes: [fix([open])] }),
    );
    assert.equal(outcome.stage, "awaiting-ci");
    assert.ok("branch" in outcome);
    assert.equal(outcome.branch, `${delivery}-cd-1`);
  });

  it("applies the CD rules to a merged fix and points to the next fix branch", () => {
    const failedFix = pr(3, { merged: true, runs: [run(5, "failed")] });
    const outcome = deliveryOutcome(
      snapshot({ delivery: failedDelivery, fixes: [fix([failedFix])] }),
    );
    assert.ok(outcome.stage === "cd-failed");
    assert.equal(outcome.branch, `${delivery}-cd-1`);
    assert.equal(outcome.nextFixBranch, `${delivery}-cd-2`);
    const fixedFix = pr(4, { merged: true, runs: [run(6, "success")] });
    const done = deliveryOutcome(
      snapshot({
        delivery: failedDelivery,
        fixes: [fix([failedFix]), fix([fixedFix], 2)],
      }),
    );
    assert.equal(done.stage, "done");
  });
});
