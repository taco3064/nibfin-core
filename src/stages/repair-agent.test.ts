import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeToken, paged, rejection } from "../github/fake-github.test.ts";
import { checkRun, issue as issueJson } from "../github/fixtures.test.ts";
import { freshReads } from "../github/index.ts";
import { StageError } from "./errors.ts";
import { failedActionsCheck } from "./fake-delivery.test.ts";
import {
  inventoryIssue,
  openPull,
  type RepairWorld,
  repairWorld,
  stopIssue,
} from "./fake-repair.test.ts";
import {
  type AgentStep,
  agentResult,
  type FakeIssue,
  fakeIssue,
  routeIssue,
  unlabel,
} from "./fake-job.test.ts";
import { requestPerson } from "./pending.ts";
import { readRepairNeed, runRepair, systemClock } from "./repair.ts";
import { bugReportUrl, runRepairStage, smallAmendments } from "./repair-agent.ts";
import { parseRepairRecord } from "./repair-record.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const blocked = () => new StageError("STAGE_BLOCKED", "Shape is blocked");

const base = {
  summary: "The cause, and what happens next.",
  evidence: ["log line 3 of job verify", "Inferred: an unrelated race"],
};

/** Hands the current stop to the agent as the route does: the `agent` record. */
async function handOff(world: RepairWorld) {
  const { client } = world.issues.github;
  freshReads(client);
  const need = await readRepairNeed(client, issue);
  const dispatcher = {
    plan: () => Promise.resolve({ kind: "ready" as const, assignee: 5 }),
    dispatch: () => Promise.resolve(),
    waitingRun: () => Promise.resolve(undefined),
  };
  assert.equal(
    await runRepair(client, issue, need!, systemClock, () => {}, dispatcher),
    "agent",
  );
  freshReads(client);
}

/** A world stopped on `error` with the agent record, and one scripted agent run. */
async function stoppedWorld(steps: AgentStep[], error: unknown = blocked()) {
  const world = await repairWorld(steps);
  routeFailedRun(world);
  await stopIssue(world, error);
  await handOff(world);
  return world;
}

function routeFailedRun(world: RepairWorld) {
  const { routes } = world.issues.github;
  const job = (id: number, name: string, conclusion: string) => ({
    id,
    name,
    status: "completed",
    conclusion,
    html_url:
      id === 32 ? null : `https://github.com/acme/runner/actions/runs/800/job/${id}`,
  });
  routes.set(
    "GET /repos/acme/runner/actions/runs/800/jobs",
    paged([job(31, "stage", "failure"), job(32, "route", "success")], "jobs"),
  );
  routes.set("GET /repos/acme/runner/actions/jobs/31/logs", {
    // A failure far from the tail, with the token on it: redacted before the cut.
    data:
      `fatal error: found pointer to free object; token ${fakeToken}\n` +
      "ok\n".repeat(250) +
      `step 1\nShape blocked\ntoken ${fakeToken}\n`,
  });
}

function run(world: RepairWorld) {
  return runRepairStage(world.context, world.issues.github.client, world.repairDeps);
}

function record(world: RepairWorld) {
  const [comment] = world.issues.marked("repair");
  return { body: comment.body, state: parseRepairRecord(comment.body)! };
}

function writes(world: RepairWorld) {
  return world.issues.github.writes().map((call) => `${call.method} ${call.path}`);
}

describe("runRepairStage", () => {
  it("gives the agent Core's evidence, redacted; reruns failed CI (C)", async () => {
    const world = await stoppedWorld([
      agentResult({ ...base, class: "C", outcome: "RERUN" }),
    ]);
    const sha = openPull(world, [failedActionsCheck(55, "verify")]);
    world.issues.github.routes.set("GET /repos/acme/app/actions/jobs/55/logs", {
      data: "verify failed in another package\n",
    });
    const dependency = fakeIssue({ number: 8, state: "closed" });
    world.issues.blockers.push(dependency);
    routeIssue(world.issues.github, dependency, []);
    world.openIssues.push(
      inventoryIssue(9, "Other work"),
      inventoryIssue(10, "Later work", ["https://github.com/acme/app/issues/9"]),
    );
    world.issues.github.routes.set("POST /repos/acme/app/actions/jobs/55/rerun", {
      status: 201,
    });
    const before = world.issues.github.writes().length;
    assert.equal(await run(world), 0);
    const [agentRun] = world.agent.runs;
    const { prompt } = agentRun;
    assert.ok(prompt.startsWith("SKILL TEXT OF repair"));
    assert.deepEqual(world.agent.skillReads, ["repair", "scope"]);
    assert.ok(!prompt.includes(fakeToken));
    for (const part of [
      "## Issue",
      "URL: https://github.com/acme/app/issues/1",
      "Labels: scope, pending",
      "Assignees: taco",
      "Blocked by: https://github.com/acme/app/issues/8 (closed)",
      "Code: `STAGE_BLOCKED`",
      "Run: https://github.com/acme/runner/actions/runs/800",
      "- stage: failed (https://github.com/acme/runner/actions/runs/800/job/31)",
      "- route: success (no URL)",
      "Shape blocked\ntoken ***",
      "Lines 1–6:\n\n```text\nfatal error: found pointer to free object; token ***\n",
      "The full log is at https://github.com/acme/runner/actions/runs/800/job/31.",
      `Head: \`${sha}\` (nibfin/issue-1)`,
      "- verify: failed (https://github.com/acme/app/runs/55)",
      "- src/widget.ts",
      "### Failed check verify",
      "verify failed in another package",
      "status=repairing action=agent",
      "- #9 https://github.com/acme/app/issues/9: Other work [labels: scope; " +
        "Blocked by: none]",
      "- #10 https://github.com/acme/app/issues/10: Later work [labels: scope; " +
        "Blocked by: https://github.com/acme/app/issues/9]",
      "## Product authority",
      "## Small amendments (scope skill)\n\nSKILL TEXT OF scope",
      "acme/app (the Issue repository): public",
    ]) {
      assert.ok(prompt.includes(part), part);
    }
    assert.ok(!prompt.includes("Hidden body"));
    assert.ok(!prompt.includes("already received an automatic step (Proposal R4.47)"));
    const { body, state } = record(world);
    assert.equal(state.status, "repairing");
    assert.equal(state.action, "rerun");
    assert.deepEqual(state.handled, ["STAGE_BLOCKED"]);
    assert.match(body, /- Category: C, unrelated flaky test\n/);
    assert.match(body, /- Reason: The cause, and what happens next\.\n/);
    assert.match(
      body,
      /\n {2}- log line 3 of job verify\n {2}- Inferred: an unrelated race\n/,
    );
    assert.match(body, /Re-ran the failed CI jobs `verify`\. `pending` stays/);
    const after = writes(world).slice(before);
    assert.equal(after.length, 2);
    assert.match(after[0], /^PATCH \/repos\/acme\/app\/issues\/comments\/\d+$/);
    assert.equal(after[1], "POST /repos/acme/app/actions/jobs/55/rerun");
    assert.ok(world.issues.main.labels.includes("pending"));
    assert.equal(world.reroutes, 0);
  });

  it("re-dispatches a rerun-fixable stop and removes pending (class B)", async () => {
    const world = await stoppedWorld([
      agentResult({ ...base, class: "B", outcome: "RERUN" }),
    ]);
    assert.equal(await run(world), 0);
    const { state, body } = record(world);
    assert.equal(state.action, "retry");
    assert.deepEqual(state.handled, ["STAGE_BLOCKED"]);
    assert.match(body, /- Category: B, Nibfin flow error\n/);
    assert.ok(!world.issues.main.labels.includes("pending"));
    assert.equal(world.reroutes, 1);
  });

  it("re-dispatches class C without a failed Actions check on the PR", async () => {
    const world = await stoppedWorld([
      agentResult({ ...base, class: "C", outcome: "RERUN" }),
    ]);
    openPull(world, [
      {
        ...checkRun(56, "verify", { conclusion: "failure", slug: "circleci" }),
        html_url: null,
      },
    ]);
    assert.equal(await run(world), 0);
    assert.equal(record(world).state.action, "retry");
    assert.equal(world.reroutes, 1);
    assert.ok(!writes(world).some((call) => call.endsWith("/rerun")));
    assert.ok(world.agent.runs[0].prompt.includes("- verify: failed (no URL)"));
  });

  it("uses NONE as the handled key of a stop without a code", async () => {
    const world = await stoppedWorld(
      [agentResult({ ...base, class: "C", outcome: "RERUN" })],
      new Error("no code"),
    );
    assert.equal(await run(world), 0);
    assert.deepEqual(record(world).state.handled, ["NONE"]);
    assert.ok(world.agent.runs[0].prompt.includes("Code: `none`"));
  });

  it("amends the Issue after its record, then removes pending (class D)", async () => {
    const blocker: FakeIssue = fakeIssue({ number: 9, title: "Owner of X" });
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "D",
        outcome: "AMEND",
        body: "The widget must exist in `src/widget.ts`.",
        blockedBy: ["https://github.com/acme/app/issues/9"],
        changeSummary: "Corrected the path, proven by the code.",
      }),
    ]);
    routeBlocker(world, blocker);
    assert.equal(await run(world), 0);
    assert.equal(world.issues.main.body, "The widget must exist in `src/widget.ts`.");
    assert.deepEqual(
      world.issues.blockers.map((item) => item.number),
      [9],
    );
    const { state, body } = record(world);
    assert.equal(state.action, "amend");
    assert.deepEqual(state.handled, ["STAGE_BLOCKED"]);
    assert.ok(
      body.includes(
        "- Done: Amending the Issue: Corrected the path, proven by the code. " +
          "Adds Blocked by https://github.com/acme/app/issues/9.",
      ),
    );
    const order = writes(world).slice(-4);
    assert.match(order[0], /^PATCH \/repos\/acme\/app\/issues\/comments\/\d+$/);
    assert.deepEqual(order.slice(1), [
      "PATCH /repos/acme/app/issues/1",
      "POST /repos/acme/app/issues/1/dependencies/blocked_by",
      "DELETE /repos/acme/app/issues/1/labels/pending",
    ]);
    assert.ok(!world.issues.main.labels.includes("pending"));
    assert.equal(world.reroutes, 1);
  });

  it("only adds Blocked by when the body is null", async () => {
    const blocker: FakeIssue = fakeIssue({ number: 9 });
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "D",
        outcome: "AMEND",
        body: null,
        blockedBy: ["https://github.com/acme/app/issues/9"],
        changeSummary: "Added the missing edge.",
      }),
    ]);
    routeBlocker(world, blocker);
    assert.equal(await run(world), 0);
    assert.ok(!writes(world).includes("PATCH /repos/acme/app/issues/1"));
    assert.equal(world.issues.main.body, "The widget must exist.");
    assert.equal(world.issues.blockers.length, 1);
  });

  it("does not edit an unchanged body", async () => {
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "D",
        outcome: "AMEND",
        body: "The widget must exist.",
        changeSummary: "Nothing to change after all.",
      }),
    ]);
    assert.equal(await run(world), 0);
    assert.ok(!writes(world).includes("PATCH /repos/acme/app/issues/1"));
    assert.ok(!world.issues.main.labels.includes("pending"));
    assert.doesNotMatch(record(world).body, /Adds Blocked by/);
  });

  it("writes numbered options and keeps pending for a decision (class E)", async () => {
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "E",
        outcome: "DECIDE",
        options: [
          {
            title: "Keep the limit",
            consequence: "Large files stay unsupported.",
            issueChange: "Out of scope gains large files.",
            recommended: false,
          },
          {
            title: "Raise the limit",
            consequence: "Large files work; slower. Recommended: it meets the outcome.",
            issueChange: "Outcome names the new limit.\n\nTests cover it.",
            recommended: true,
          },
        ],
      }),
    ]);
    assert.equal(await run(world), 0);
    const { state, body } = record(world);
    assert.equal(state.status, "waiting-for-choice");
    assert.equal(state.action, "options");
    assert.deepEqual(state.handled, []);
    assert.match(body, /- Category: E, product decision\n/);
    assert.match(body, /Reply with only the number of the option/);
    assert.ok(
      body.endsWith(
        [
          "### Options",
          "",
          "1. **Keep the limit**",
          "   Large files stay unsupported.",
          "   Issue change: Out of scope gains large files.",
          "2. **Raise the limit** (recommended)",
          "   Large files work; slower. Recommended: it meets the outcome.",
          "   Issue change: Outcome names the new limit.",
          "",
          "   Tests cover it.",
        ].join("\n"),
      ),
    );
    assert.ok(world.issues.main.labels.includes("pending"));
    assert.equal(world.reroutes, 0);
  });

  it("writes follow-up steps and a bug report for a Nibfin defect (B)", async () => {
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "B",
        outcome: "FOLLOW_UP",
        steps: [
          {
            text: "Read the run log.",
            link: "https://github.com/acme/runner/actions/runs/800",
          },
          { text: "Resolve the conflict by hand.", command: "git rebase origin/main" },
          {
            text: "Remove pending.",
            link: "https://github.com/acme/app/issues/1",
            command: "gh issue edit 1 --remove-label pending",
          },
        ],
        bugReport: { title: "Parse fails", body: `What happened.\n\ntoken ${fakeToken}` },
      }),
    ]);
    assert.equal(await run(world), 0);
    const { state, body } = record(world);
    assert.equal(state.status, "needs-person");
    assert.equal(state.action, "advice");
    assert.match(
      body,
      /- Advice: Follow the steps below, and file the bug report below them\./,
    );
    assert.ok(
      body.includes(
        "1. Read the run log.\n   Link: https://github.com/acme/runner/actions/runs/800",
      ),
    );
    assert.ok(
      body.includes(
        "2. Resolve the conflict by hand.\n   ```sh\n   git rebase origin/main\n   ```",
      ),
    );
    assert.ok(body.includes(`File it at ${bugReportUrl} with this title and body.`));
    assert.ok(body.includes("Title: Parse fails"));
    assert.ok(body.includes("```markdown\nWhat happened.\n\ntoken ***\n```"));
    assert.ok(!body.includes(fakeToken));
    assert.ok(world.issues.main.labels.includes("pending"));
  });

  it("writes follow-up steps without a bug report for an operation (F)", async () => {
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "F",
        outcome: "FOLLOW_UP",
        steps: [{ text: "Set NIBFIN_PROVIDER on <runner>.", command: "nibfin doctor" }],
      }),
    ]);
    assert.equal(await run(world), 0);
    const { body } = record(world);
    assert.match(body, /- Category: F, operation or manual action\n/);
    assert.match(body, /- Advice: Follow the steps below\.\n/);
    assert.ok(!body.includes("Bug report"));
  });

  it("rejects Rerun and Amend for a cause already handled (R4.47)", async () => {
    const world = await repairWorld([
      agentResult({ ...base, class: "A", outcome: "RERUN" }),
    ]);
    routeFailedRun(world);
    const git = new StageError("STAGE_GIT_FAILED", "git failed");
    await stopIssue(world, git);
    const { client } = world.issues.github;
    const need = await readRepairNeed(client, issue);
    await runRepair(client, issue, need!, systemClock, () => {}, unusedDispatcher);
    // The same code stops the Issue again: the agent gets it with the guard.
    await stopIssue(world, git, 801);
    world.issues.github.routes.set(
      "GET /repos/acme/runner/actions/runs/801/jobs",
      paged([], "jobs"),
    );
    await handOff(world);
    const error = await rejection(run(world));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_RESULT_INVALID");
    assert.match(error.message, /already received an automatic step/);
    const { prompt } = world.agent.runs[0];
    assert.ok(prompt.includes("already received an automatic step (Proposal R4.47)"));
    assert.ok(prompt.includes("Jobs of the latest attempt:\n\nNone."));
    assert.equal(record(world).state.action, "agent");
  });

  it("does not follow a run link outside the execution repository", async () => {
    const world = await repairWorld([
      agentResult({ ...base, class: "A", outcome: "RERUN" }),
    ]);
    const url = "https://github.com/other/place/actions/runs/800";
    await requestPerson(world.issues.github.client, issue, blocked(), url);
    await handOff(world);
    assert.equal(await run(world), 0);
    const { prompt } = world.agent.runs[0];
    assert.ok(prompt.includes("Not available: the `pending` comment names no run"));
    assert.ok(prompt.includes("The Issue has no open pull request."));
    assert.ok(
      !world.issues.github.calls.some((call) => call.path.startsWith("/repos/other")),
    );
  });

  it("describes an Issue without body, run, checks, files or other Issues", async () => {
    const world = await repairWorld([
      agentResult({ ...base, class: "A", outcome: "RERUN" }),
    ]);
    world.issues.main.body = "";
    world.openIssues = [];
    await requestPerson(world.issues.github.client, issue, blocked(), undefined);
    await handOff(world);
    openPull(world, []);
    world.required = [];
    world.issues.github.routes.set("GET /repos/acme/app/pulls/7/files", paged([]));
    assert.equal(await run(world), 0);
    const { prompt } = world.agent.runs[0];
    for (const part of [
      "(no description)",
      "Run: unknown",
      "Not available: the `pending` comment names no run",
      "Required checks:\n\nNone reported.",
      "Changed files:\n\nNone.",
      "## Open Issues of acme/app\n\nNone.",
    ]) {
      assert.ok(prompt.includes(part), part);
    }
  });

  it("follows no run link without an execution repository", async () => {
    const world = await stoppedWorld([
      agentResult({ ...base, class: "A", outcome: "RERUN" }),
    ]);
    delete world.context.runRepo;
    assert.equal(await run(world), 0);
    assert.ok(world.agent.runs[0].prompt.includes("Not available"));
  });

  it("does nothing without an agent record for the current stop", async () => {
    const world = await repairWorld();
    await stopIssue(world, blocked());
    assert.equal(await run(world), 0);
    assert.deepEqual(world.agent.runs, []);
    assert.deepEqual(world.issues.marked("repair"), []);
    assert.match(
      world.agent.logs.at(-1)!,
      /no repair agent record covers the current stop/,
    );
  });

  for (const [name, change, what] of [
    ["paused", (main: FakeIssue) => void main.labels.push("pause"), "`pause` was added"],
    ["closed", (main: FakeIssue) => void (main.state = "closed"), "the Issue was closed"],
    [
      "unscoped",
      (main: FakeIssue) => void main.labels.splice(main.labels.indexOf("scope"), 1),
      "the Issue lost its `scope` label",
    ],
  ] as const) {
    it(`writes needs-person, runs no agent when ${name} before it starts`, async () => {
      const world = await stoppedWorld([]);
      change(world.issues.main);
      assert.equal(await run(world), 0);
      assert.deepEqual(world.agent.runs, []);
      const { state, body } = record(world);
      assert.equal(state.status, "needs-person");
      assert.equal(state.action, "advice");
      assert.ok(
        body.includes(`- Done: Nothing; ${what} before the repair agent started`),
      );
      assert.match(body, /then remove `pending` to run again\./);
      // A later route has nothing to do for that stop.
      freshReads(world.issues.github.client);
      assert.equal(await readRepairNeed(world.issues.github.client, issue), null);
    });

    it(`writes needs-person, applies nothing when ${name} while it works`, async () => {
      const world = await stoppedWorld([
        () => {
          change(world.issues.main);
          return agentResult({ ...base, class: "B", outcome: "RERUN" });
        },
      ]);
      assert.equal(await run(world), 0);
      const { state, body } = record(world);
      assert.equal(state.status, "needs-person");
      assert.deepEqual(state.handled, []);
      assert.ok(
        body.includes(`while the repair agent worked, so its result was not applied`),
      );
      assert.match(body, /The repair agent proposed to rerun the failed step\./);
      assert.ok(world.issues.main.labels.includes("pending"));
      assert.equal(world.reroutes, 0);
    });
  }

  it("names each proposal in one line when it was not applied", async () => {
    const results = [
      { class: "D", outcome: "AMEND", body: "New", changeSummary: "Fix the path." },
      {
        class: "E",
        outcome: "DECIDE",
        options: [
          { title: "One", consequence: "c", issueChange: "i", recommended: true },
          { title: "Two", consequence: "c", issueChange: "i", recommended: false },
        ],
      },
      { class: "F", outcome: "FOLLOW_UP", steps: [{ text: "Do\nit.", command: "x" }] },
    ];
    const expected = [
      "proposed to amend the Issue: Fix the path.",
      "proposed to choose between: One; Two.",
      "proposed to follow up: Do it.",
    ];
    for (const [index, result] of results.entries()) {
      const world = await stoppedWorld([
        () => {
          world.issues.main.labels.push("pause");
          return agentResult({ ...base, ...result });
        },
      ]);
      assert.equal(await run(world), 0);
      assert.ok(record(world).body.includes(expected[index]), expected[index]);
    }
  });

  it("writes nothing when pending was removed while it works", async () => {
    const world = await stoppedWorld([
      () => {
        const { main } = world.issues;
        main.labels.splice(main.labels.indexOf("pending"), 1);
        unlabel(main, "pending");
        return agentResult({ ...base, class: "B", outcome: "RERUN" });
      },
    ]);
    const before = world.issues.github.writes().length;
    assert.equal(await run(world), 0);
    assert.equal(world.issues.github.writes().length, before);
    assert.match(
      world.agent.logs.at(-1)!,
      /the stop changed while the repair agent worked/,
    );
  });

  it("writes nothing when a new stop came while it works", async () => {
    let before = 0;
    const world = await stoppedWorld([
      async () => {
        await stopIssue(world, new StageError("STAGE_GIT_FAILED", "new"), 802);
        before = world.issues.github.writes().length;
        return agentResult({ ...base, class: "B", outcome: "RERUN" });
      },
    ]);
    assert.equal(await run(world), 0);
    assert.equal(world.issues.github.writes().length, before);
  });

  it("does not amend a body that changed while it works", async () => {
    const world = await stoppedWorld([
      () => {
        world.issues.main.body = "Edited by a person.";
        return agentResult({
          ...base,
          class: "D",
          outcome: "AMEND",
          body: "Amended.",
          changeSummary: "Fix the path.",
        });
      },
    ]);
    assert.equal(await run(world), 0);
    assert.equal(world.issues.main.body, "Edited by a person.");
    const { state, body } = record(world);
    assert.equal(state.status, "needs-person");
    assert.match(
      body,
      /- Done: Nothing; the Issue body changed while the repair agent worked\./,
    );
    assert.match(
      body,
      /The repair agent proposed: Fix the path\. Check whether it is still needed/,
    );
    assert.ok(world.issues.main.labels.includes("pending"));
  });

  it("fails unconfirmed when the amended body does not read back", async () => {
    const world = await stoppedWorld([
      agentResult({
        ...base,
        class: "D",
        outcome: "AMEND",
        body: "Amended.",
        changeSummary: "Fix the path.",
      }),
    ]);
    world.issues.github.routes.set("PATCH /repos/acme/app/issues/1", { data: {} });
    const error = await rejection(run(world));
    assert.equal((error as { code?: string }).code, "GITHUB_WRITE_UNCONFIRMED");
    // The record was written first, so the route ends the stop as R4.50 says.
    assert.equal(record(world).state.action, "amend");
  });
});

describe("smallAmendments", () => {
  it("takes the section up to the next heading of its level or above", () => {
    const skill = [
      "# Scope",
      "### Small amendments",
      "",
      "One of:",
      "#### Detail",
      "kept",
      "## Audit",
      "dropped",
    ].join("\n");
    assert.equal(
      smallAmendments(skill),
      "### Small amendments\n\nOne of:\n#### Detail\nkept",
    );
    assert.equal(
      smallAmendments("### Small amendments\nAll."),
      "### Small amendments\nAll.",
    );
    assert.equal(smallAmendments("No such section."), "No such section.");
  });
});

const unusedDispatcher = {
  plan: () => Promise.reject(new Error("not planned")),
  dispatch: () => Promise.reject(new Error("not dispatched")),
  waitingRun: () => Promise.reject(new Error("not read")),
};

/** Routes acme/app#9 and the native Blocked by edge #1 ← #9. */
function routeBlocker(world: RepairWorld, blocker: FakeIssue) {
  const { github, blockers, main } = world.issues;
  routeIssue(github, blocker, []);
  github.routes.set("GET /repos/acme/app/issues/9", () => ({
    data: {
      ...issueJson(9, { totalBlocking: blockers.includes(blocker) ? 1 : 0 }),
      title: blocker.title,
      body: blocker.body,
    },
  }));
  github.routes.set("POST /repos/acme/app/issues/1/dependencies/blocked_by", () => {
    blockers.push(blocker);
    return { status: 201, data: {} };
  });
  github.routes.set("GET /repos/acme/app/issues/9/dependencies/blocking", (request) =>
    paged(
      blockers.includes(blocker)
        ? [issueJson(main.number, { labels: main.labels, assignees: main.assignees })]
        : [],
    )(request),
  );
}
