import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BaseCd, PreviousFix, PreviousIssue } from "./base-cd.ts";
import type { CdState, WorkflowRunSummary } from "./cd-runs.ts";
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
  baseCd?: BaseCd | null;
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
    baseCd: options.baseCd ?? null,
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

describe("deriveStage: request Issues (#734)", () => {
  it("applies pause, pending, blockers and Assignees to a request, in order", () => {
    const open = { labels: ["request", "pause", "pending"], assignees: 0 };
    const blockedBy = [dependency("open")];
    const paused = snapshot({ ...open, blockedBy });
    assert.deepEqual(stageOf(deriveStage(paused)), ["ineligible", "paused"]);
    const waiting = snapshot({ ...open, labels: ["request", "pending"], blockedBy });
    assert.deepEqual(stageOf(deriveStage(waiting)), ["ineligible", "pending"]);
    const blocked = snapshot({ ...open, labels: ["request"], blockedBy });
    assert.deepEqual(stageOf(deriveStage(blocked)), ["ineligible", "blocked"]);
    const free = snapshot({ ...open, labels: ["request"] });
    assert.deepEqual(stageOf(deriveStage(free)), ["ineligible", "no-assignee"]);
  });

  it("derives scope for an open request without scope", () => {
    for (const labels of [["request"], ["request", "shaped"]]) {
      assert.deepEqual(deriveStage(snapshot({ labels })), { stage: "scope" });
    }
    const resolved = dependency("closed", ["delivered"]);
    const unblocked = snapshot({ labels: ["request"], blockedBy: [resolved] });
    assert.deepEqual(deriveStage(unblocked), { stage: "scope" });
  });

  it("keeps today's lifecycle for an Issue with scope, with or without request", () => {
    for (const extra of [[], ["request"]]) {
      const shape = snapshot({ labels: ["scope", ...extra] });
      assert.deepEqual(deriveStage(shape), { stage: "shape" });
      const shaped = snapshot({ labels: ["scope", "shaped", ...extra] });
      assert.equal(deriveStage(shaped).stage, "deliver");
    }
  });

  it("is closed or no-scope without the labels that make it a request", () => {
    const closed = snapshot({ state: "closed", labels: ["request"] });
    assert.deepEqual(stageOf(deriveStage(closed)), ["ineligible", "closed"]);
    const plain = snapshot({ labels: ["shaped", "pending"] });
    assert.deepEqual(stageOf(deriveStage(plain)), ["ineligible", "no-scope"]);
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

describe("deliveryOutcome: a red merge on the base branch (#772)", () => {
  const cdRun = (id: number, workflow: string, state: RunState): WorkflowRunSummary => ({
    ...run(id, state),
    name: workflow,
    path: `${workflow}.yml`,
  });
  const cd = (sha: string, runs: WorkflowRunSummary[], nibfin = true): CdState => ({
    mergeCommitSha: sha,
    nibfinRunPresent: nibfin,
    runs,
  });
  const ownRuns = [cdRun(1, "ci", "failed"), cdRun(2, "lint", "success")];
  const base = (fields: Partial<BaseCd>): BaseCd => ({
    heads: ["m2"],
    newest: null,
    previous: null,
    previousIssue: null,
    ...fields,
  });
  const outcome = (baseCd: BaseCd, runs = ownRuns) =>
    deliveryOutcome(snapshot({ delivery: [pr(2, { merged: true, runs })], baseCd }));
  const red = cd("m0", [cdRun(5, "ci", "failed")]);
  const green = (sha: string, runs = [cdRun(7, "ci", "success")]) => cd(sha, runs);
  const fixOf = (fields: Partial<PreviousFix> = {}): PreviousFix => ({
    mergeCommitSha: "f9",
    pullRequestUrl: "https://github.com/acme/app/pull/90",
    newerThanMerge: true,
    containsMerge: true,
    cd: green("f9"),
    ...fields,
  });
  const afterRed = (issue: PreviousIssue) =>
    outcome(base({ previous: red, previousIssue: issue }));

  it("finishes when the newest head passes for the merge", () => {
    const newest = green("m4");
    const stage = outcome(base({ newest, previous: red }));
    assert.deepEqual(stage, {
      stage: "done",
      branch: delivery,
      pullRequest: stage.stage === "done" ? stage.pullRequest : undefined,
      passedOn: newest,
    });
  });

  it("does not count a green newest head that did not re-run a failed path", () => {
    const newest = green("m4", [cdRun(8, "lint", "success")]);
    const stage = outcome(base({ newest }));
    assert.equal(stage.stage, "cd-failed");
    assert.ok(stage.stage === "cd-failed");
    assert.equal(stage.runs, ownRuns);
    assert.equal(stage.failedOn, undefined);
    const pending = cd("m4", [cdRun(8, "ci", "success"), cdRun(9, "x", "pending")]);
    assert.equal(outcome(base({ newest: pending })).stage, "cd-failed");
    const noNibfin = cd("m4", [cdRun(8, "ci", "success")], false);
    assert.equal(outcome(base({ newest: noNibfin })).stage, "cd-failed");
  });

  it("fixes its own merge when it is the first red push", () => {
    for (const fields of [
      {},
      { previous: green("m0") },
      { previous: red },
      { previous: red, previousIssue: { number: 1, open: true, fix: null } },
    ]) {
      const stage = outcome(base(fields));
      assert.equal(stage.stage, "cd-failed");
      assert.ok(stage.stage === "cd-failed");
      assert.equal(stage.runs, ownRuns);
      assert.equal(stage.nextFixBranch, `${delivery}-cd-1`);
    }
  });

  it("waits while the previous push still runs CD", () => {
    for (const previous of [
      cd("m0", [], false),
      cd("m0", [cdRun(5, "ci", "pending"), cdRun(6, "lint", "success")]),
    ]) {
      const stage = outcome(base({ previous }));
      assert.deepEqual(stageOf(stage), ["awaiting-cd", "previous-cd-pending"]);
      assert.ok(stage.stage === "awaiting-cd");
      assert.equal(stage.waitingOn, undefined);
      assert.equal(stage.runs, ownRuns);
    }
  });

  it("waits for the open Issue that made the base red, fixes for a closed one", () => {
    const waiting = afterRed({ number: 7, open: true, fix: null });
    assert.deepEqual(stageOf(waiting), ["awaiting-cd", "previous-cd-red"]);
    assert.ok(waiting.stage === "awaiting-cd");
    assert.equal(waiting.waitingOn, 7);
    const fixing = afterRed({ number: 7, open: false, fix: null });
    assert.ok(fixing.stage === "cd-failed");
    assert.equal(fixing.runs, ownRuns);
  });

  it("waits for the previous Issue's fix to complete CD on a newer head", () => {
    for (const fix of [
      fixOf({ newerThanMerge: false }),
      fixOf({ cd: cd("f9", [], false) }),
      fixOf({ cd: cd("f9", [cdRun(7, "ci", "pending")]) }),
    ]) {
      const stage = afterRed({ number: 7, open: true, fix });
      assert.deepEqual(stageOf(stage), ["awaiting-cd", "previous-fix-cd-pending"]);
      assert.ok(stage.stage === "awaiting-cd");
      assert.equal(stage.waitingOn, 7);
    }
  });

  it("fixes the failure of the previous Issue's red fix, open or closed", () => {
    const fixRuns = [cdRun(7, "ci", "failed"), cdRun(8, "lint", "pending")];
    for (const open of [true, false]) {
      const fix = fixOf({ cd: cd("f9", fixRuns) });
      const stage = afterRed({ number: 7, open, fix });
      assert.ok(stage.stage === "cd-failed");
      assert.equal(stage.runs, fixRuns);
      assert.deepEqual(stage.failedOn, {
        mergeCommitSha: "f9",
        pullRequestUrl: "https://github.com/acme/app/pull/90",
      });
    }
  });

  it("finishes on the previous Issue's fix that passes, open or closed", () => {
    for (const open of [true, false]) {
      const fix = fixOf();
      const stage = afterRed({ number: 7, open, fix });
      assert.ok(stage.stage === "done");
      assert.equal(stage.passedOn, fix.cd);
    }
  });

  it("fixes its own merge when the previous fix does not contain it (#795)", () => {
    for (const open of [true, false]) {
      const fix = fixOf({ containsMerge: false });
      const stage = afterRed({ number: 7, open, fix });
      assert.ok(stage.stage === "cd-failed");
      assert.equal(stage.runs, ownRuns);
      assert.equal(stage.failedOn, undefined);
      assert.equal(stage.nextFixBranch, `${delivery}-cd-1`);
    }
  });

  it("fixes the failed paths the previous Issue's green fix did not re-run", () => {
    const own = [cdRun(1, "ci", "failed"), cdRun(2, "image", "failed")];
    const fix = fixOf({ cd: green("f9", [cdRun(7, "ci", "success")]) });
    const stage = outcome(
      base({ previous: red, previousIssue: { number: 7, open: true, fix } }),
      own,
    );
    assert.ok(stage.stage === "cd-failed");
    assert.deepEqual(stage.runs, [own[1]]);
    assert.equal(stage.failedOn, undefined);
  });
});
