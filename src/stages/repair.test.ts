import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentError } from "../agent/index.ts";
import { rejection } from "../github/fake-github.test.ts";
import { freshReads, GitHubError, upsertMarkedComment } from "../github/index.ts";
import { checkRun } from "../github/fixtures.test.ts";
import { StageError } from "./errors.ts";
import { deliveryWorld } from "./fake-delivery.test.ts";
import { openPull } from "./fake-repair.test.ts";
import {
  type FakeIssues,
  fakeIssue,
  fakeIssues,
  seedComment,
  unlabel,
} from "./fake-job.test.ts";
import { requestPerson } from "./pending.ts";
import {
  jobLimitMinutes,
  type RepairClock,
  type RepairDispatcher,
  type RepairDispatchPlan,
  readRepairNeed,
  runRepair,
  systemClock,
} from "./repair.ts";
import {
  formatRepairRecord,
  parseRepairRecord,
  pendingDigest,
  type RepairAction,
} from "./repair-record.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const url = "https://github.com/acme/runner/actions/runs/900";
const start = Date.parse("2026-11-27T12:00:00Z");
const minute = 60_000;

/** A clock at `start` whose sleep moves it on and runs `during` first. */
function testClock(during?: () => void | Promise<void>) {
  const slept: number[] = [];
  let now = start;
  const clock: RepairClock = {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
      await during?.();
    },
    jobStart: start,
  };
  return { clock, slept };
}

const gitFailed = (message = "git failed") => new StageError("STAGE_GIT_FAILED", message);
const usageLimit = (reset?: string) =>
  new AgentError(
    "AGENT_USAGE_LIMIT",
    "limit",
    reset === undefined ? {} : { usageLimitReset: reset },
  );

/** An Issue with `scope` that stopped on `error`: its `pending` comment and label. */
async function stopped(error: unknown, runId = 900): Promise<FakeIssues> {
  const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
  await stopAgain(issues, error, runId);
  return issues;
}

async function stopAgain(issues: FakeIssues, error: unknown, runId: number) {
  const run = `https://github.com/acme/runner/actions/runs/${runId}`;
  await requestPerson(issues.github.client, issue, error, run);
}

function record(issues: FakeIssues) {
  const comments = issues.marked("repair");
  assert.equal(comments.length, 1);
  return { body: comments[0].body, state: parseRepairRecord(comments[0].body)! };
}

const log = () => {};

/** A repair dispatcher that records what the stage asked of it. */
function fakeDispatcher(plan: RepairDispatchPlan = { kind: "ready", assignee: 5 }) {
  const calls: string[] = [];
  let waiting: number | undefined;
  const dispatcher: RepairDispatcher = {
    plan: () => {
      calls.push("plan");
      return Promise.resolve(plan);
    },
    dispatch: (assignee) => {
      calls.push(`dispatch ${assignee}`);
      return Promise.resolve();
    },
    waitingRun: () => {
      calls.push("waitingRun");
      return Promise.resolve(waiting);
    },
  };
  return {
    dispatcher,
    calls,
    wait: (id: number | undefined) => {
      waiting = id;
    },
  };
}

const noDispatch = fakeDispatcher().dispatcher;

async function repair(
  issues: FakeIssues,
  clock: RepairClock,
  dispatcher: RepairDispatcher = noDispatch,
) {
  const need = await readRepairNeed(issues.github.client, issue);
  assert.notEqual(need, null);
  return runRepair(issues.github.client, issue, need!, clock, log, dispatcher);
}

describe("readRepairNeed", () => {
  it("is new for the current pending comment without a record", async () => {
    const issues = await stopped(gitFailed());
    const need = await readRepairNeed(issues.github.client, issue);
    const [comment] = issues.marked("pending");
    assert.equal(need?.kind, "new");
    assert.equal(need?.record, null);
    assert.equal(need?.pending?.id, comment.id);
    assert.equal(need?.pending?.digest, pendingDigest(comment.body));
    assert.match(need?.pending?.url ?? "", /#issuecomment-/);
  });

  it("is new without a current pending comment", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope", "pending"] }));
    const need = await readRepairNeed(issues.github.client, issue);
    assert.deepEqual(need, { kind: "new", pending: null, record: null });
  });

  it("does not count a pending comment older than the last removal", async () => {
    const issues = await stopped(gitFailed());
    unlabel(issues.main, "pending");
    issues.main.events!.unshift({ event: "labeled", created_at: "2026-01-01T00:00:00Z" });
    issues.main.events!.push({
      event: "unlabeled",
      created_at: "2026-01-01T00:00:00Z",
      label: { name: "pending" },
    });
    issues.main.events!.push({ event: "unlabeled", created_at: "2030-01-01T00:00:00Z" });
    const need = await readRepairNeed(issues.github.client, issue);
    assert.equal(need?.kind, "new");
    assert.equal(need?.pending, null);
  });

  it("is nothing when the repair stage itself failed for this stop (R4.50)", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    await requestPerson(issues.github.client, issue, gitFailed(), url, "repair");
    assert.equal(await readRepairNeed(issues.github.client, issue), null);
  });

  it("ignores an unreadable record and other authors' comments", async () => {
    const issues = await stopped(gitFailed());
    seedComment(issues, issues.main, "<!-- nibfin:repair -->\nNot a state line.");
    const [pending] = issues.marked("pending");
    const forged = formatRepairRecord(
      {
        for: pendingDigest(pending.body),
        status: "needs-person",
        action: "advice",
        handled: [],
      },
      { category: "x", reason: "x", evidence: "x", done: "x", advice: "x" },
    );
    seedComment(issues, issues.main, `<!-- nibfin:repair -->\n${forged}`, 77);
    freshReads(issues.github.client);
    const need = await readRepairNeed(issues.github.client, issue);
    assert.equal(need?.kind, "new");
    assert.equal(need?.record, null);
  });
});

describe("runRepair", () => {
  it("retries a temporary stop once and removes pending (R4.42)", async () => {
    const issues = await stopped(gitFailed());
    const { clock, slept } = testClock();
    assert.equal(await repair(issues, clock), "released");
    assert.deepEqual(slept, []);
    assert.ok(!issues.main.labels.includes("pending"));
    const { body, state } = record(issues);
    const [pending] = issues.marked("pending");
    assert.deepEqual(state, {
      for: pendingDigest(pending.body),
      status: "repairing",
      action: "retry",
      handled: ["STAGE_GIT_FAILED"],
    });
    assert.match(body, /- Category: external temporary problem\n/);
    assert.match(body, /- Reason: The stop for `STAGE_GIT_FAILED` looks temporary/);
    assert.ok(
      body.includes(`- Evidence: code \`STAGE_GIT_FAILED\`, [the \`pending\` comment](`),
    );
    assert.ok(body.includes(`, run ${url}\n`));
    assert.ok(!body.includes("git failed"));
  });

  it("leaves the run out of the evidence when the stop has none", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    await requestPerson(issues.github.client, issue, gitFailed(), undefined);
    assert.equal(await repair(issues, testClock().clock), "released");
    assert.match(
      record(issues).body,
      /- Evidence: code `STAGE_GIT_FAILED`, \[the `pending` comment\]\([^)]+\)\n/,
    );
  });

  it("hands a second stop for the same code to the agent (R4.47)", async () => {
    const issues = await stopped(gitFailed());
    await repair(issues, testClock().clock);
    await stopAgain(issues, gitFailed("again"), 901);
    const fake = fakeDispatcher();
    assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "agent");
    assert.deepEqual(fake.calls, ["plan", "dispatch 5"]);
    assert.ok(issues.main.labels.includes("pending"));
    const { body, state } = record(issues);
    assert.equal(state.status, "repairing");
    assert.equal(state.action, "agent");
    assert.deepEqual(state.handled, ["STAGE_GIT_FAILED"]);
    assert.match(body, /- Category: being classified\n/);
    assert.match(body, /- Done: Dispatched the repair agent\./);
  });

  it("retries another temporary code after one was handled", async () => {
    const issues = await stopped(gitFailed());
    await repair(issues, testClock().clock);
    const read = new GitHubError("GITHUB_READ_FAILED", "read", new Error("x"));
    await stopAgain(issues, read, 901);
    assert.equal(await repair(issues, testClock().clock), "released");
    assert.deepEqual(record(issues).state.handled, [
      "STAGE_GIT_FAILED",
      "GITHUB_READ_FAILED",
    ]);
  });

  it("waits in the Job for a usage-limit reset, then removes pending", async () => {
    const reset = new Date(start + 2 * 60 * minute).toISOString();
    const issues = await stopped(usageLimit(reset));
    const { clock, slept } = testClock();
    assert.equal(await repair(issues, clock), "released");
    assert.deepEqual(slept, [2 * 60 * minute + minute]);
    assert.ok(!issues.main.labels.includes("pending"));
    const { body, state } = record(issues);
    assert.equal(state.action, "wait");
    assert.equal(state.reset, reset);
    assert.deepEqual(state.handled, ["AGENT_USAGE_LIMIT"]);
    assert.match(body, /- Category: external temporary problem \(provider usage limit\)/);
    assert.ok(body.includes(`waiting in its route Job until \`${reset}\``));
  });

  it("waits up to the Job limit and no longer", async () => {
    const last = new Date(start + (jobLimitMinutes - 1) * minute).toISOString();
    assert.equal(
      await repair(await stopped(usageLimit(last)), testClock().clock),
      "released",
    );
    const late = new Date(start + (jobLimitMinutes - 1) * minute + 1000).toISOString();
    const issues = await stopped(usageLimit(late));
    assert.equal(await repair(issues, testClock().clock), "advised");
    const { body, state } = record(issues);
    assert.equal(state.status, "needs-person");
    assert.deepEqual(state.handled, []);
    assert.ok(body.includes(`it resets at \`${late}\`, which Nibfin cannot wait for`));
    assert.ok(body.includes(`Remove the \`pending\` label after \`${late}\`.`));
  });

  it("advises with the reported reset when it is not an exact time", async () => {
    for (const reset of ["Nov 27th, 2026 6:00 PM", "2026-13-45T99:00:00Z"]) {
      const issues = await stopped(usageLimit(reset));
      assert.equal(await repair(issues, testClock().clock), "advised");
      assert.ok(record(issues).body.includes(`after \`${reset}\``));
      assert.ok(issues.main.labels.includes("pending"));
    }
  });

  it("advises when the CLI reported no reset", async () => {
    const issues = await stopped(usageLimit());
    assert.equal(await repair(issues, testClock().clock), "advised");
    assert.match(record(issues).body, /the CLI did not report when it resets/);
  });

  it("advises on a second usage-limit stop", async () => {
    const reset = new Date(start).toISOString();
    const issues = await stopped(usageLimit(reset));
    await repair(issues, testClock().clock);
    await stopAgain(issues, usageLimit(reset), 901);
    assert.equal(await repair(issues, testClock().clock), "advised");
    assert.match(
      record(issues).body,
      /provider usage limit\)\n- Reason: This Issue stopped/,
    );
  });

  it("hands a code it cannot decide and a stop without a code to the agent", async () => {
    for (const error of [new StageError("STAGE_BLOCKED", "x"), new Error("x")]) {
      const issues = await stopped(error);
      const fake = fakeDispatcher();
      assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "agent");
      assert.deepEqual(fake.calls, ["plan", "dispatch 5"]);
      const { state } = record(issues);
      assert.equal(state.action, "agent");
      assert.deepEqual(state.handled, []);
      // The queued repair run resumes the record: the route writes nothing more.
      fake.wait(1001);
      const writes = issues.github.writes().length;
      assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "stopped");
      assert.equal(issues.github.writes().length, writes);
    }
  });

  it("writes the agent record without dispatching when a repair run waits", async () => {
    const issues = await stopped(new StageError("STAGE_BLOCKED", "x"));
    const fake = fakeDispatcher({ kind: "waiting", runId: 1001 });
    assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "agent");
    assert.deepEqual(fake.calls, ["plan"]);
    assert.equal(record(issues).state.action, "agent");
  });

  it("writes no record when the plan asked for consent", async () => {
    const issues = await stopped(new StageError("STAGE_BLOCKED", "x"));
    const fake = fakeDispatcher({ kind: "consent" });
    const writes = issues.github.writes().length;
    assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "stopped");
    assert.deepEqual(fake.calls, ["plan"]);
    assert.deepEqual(issues.marked("repair"), []);
    assert.equal(issues.github.writes().length, writes);
  });

  it("advises when no runner of an Assignee can run the agent", async () => {
    const issues = await stopped(new StageError("STAGE_BLOCKED", "x"));
    const fake = fakeDispatcher({ kind: "none" });
    assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "advised");
    const { body, state } = record(issues);
    assert.equal(state.status, "needs-person");
    assert.equal(state.action, "advice");
    assert.match(body, /- Reason: No runner of an Assignee can run the repair agent\./);
    assert.ok(issues.main.labels.includes("pending"));
    assert.equal(await readRepairNeed(issues.github.client, issue), null);
  });

  it("never hands a usage limit to the agent (R4.43)", async () => {
    const issues = await stopped(usageLimit());
    const fake = fakeDispatcher();
    assert.equal(await repair(issues, testClock().clock, fake.dispatcher), "advised");
    assert.deepEqual(fake.calls, []);
  });

  /** Seeds a `repairing` record with `action` for the current `pending` comment. */
  async function seedRecord(issues: FakeIssues, action: RepairAction) {
    const [pending] = issues.marked("pending");
    const state = {
      for: pendingDigest(pending.body),
      status: "repairing",
      action,
      handled: [],
    } as const;
    const text = { category: "c", reason: "r", evidence: "e", done: "d", advice: "a" };
    await upsertMarkedComment(
      issues.github.client,
      issue,
      "repair",
      formatRepairRecord(state, text),
    );
  }

  for (const action of ["agent", "amend"] as const) {
    it(`ends a resumed ${action} record without a waiting run (R4.50)`, async () => {
      const issues = await stopped(new StageError("STAGE_BLOCKED", "x"));
      await seedRecord(issues, action);
      const fake = fakeDispatcher();
      const writes = issues.github.writes().length;
      const error = await rejection(repair(issues, testClock().clock, fake.dispatcher));
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_REPAIR_ENDED");
      assert.match(error.message, /ended without a result/);
      assert.equal(/partly applied/.test(error.message), action === "amend");
      assert.deepEqual(fake.calls, ["waitingRun"]);
      assert.equal(issues.github.writes().length, writes);
    });
  }

  it("keeps a resumed rerun while required checks are pending", async () => {
    const world = await deliveryWorld({ noShape: true });
    const { issues } = world;
    await stopAgain(issues, new StageError("STAGE_BLOCKED", "x"), 900);
    await seedRecord(issues, "rerun");
    const head = openPull(world, [checkRun(55, "verify", { status: "in_progress" })]);
    freshReads(issues.github.client);
    const writes = issues.github.writes().length;
    assert.equal(await repair(issues, testClock().clock), "stopped");
    assert.equal(issues.github.writes().length, writes);
    assert.ok(issues.main.labels.includes("pending"));
    world.checkRuns.set(head, [checkRun(56, "verify", { conclusion: "failure" })]);
    freshReads(issues.github.client);
    assert.equal(await repair(issues, testClock().clock), "released");
    assert.ok(!issues.main.labels.includes("pending"));
  });

  it("releases a resumed rerun without an open pull request", async () => {
    const issues = await stopped(new StageError("STAGE_BLOCKED", "x"));
    await seedRecord(issues, "rerun");
    assert.equal(await repair(issues, testClock().clock), "released");
  });

  it("advises when pending has no current Nibfin comment", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope", "pending"] }));
    assert.equal(await repair(issues, testClock().clock), "advised");
    const { body, state } = record(issues);
    assert.equal(state.for, pendingDigest(""));
    assert.match(body, /- Evidence: no Nibfin `pending` comment since/);
    assert.ok(issues.main.labels.includes("pending"));
  });

  it("resumes a retry after a crash between the record and the release", async () => {
    const issues = await stopped(gitFailed());
    const [pending] = issues.marked("pending");
    const state = {
      for: pendingDigest(pending.body),
      status: "repairing",
      action: "retry",
      handled: ["STAGE_GIT_FAILED"],
    } as const;
    const text = { category: "c", reason: "r", evidence: "e", done: "d", advice: "a" };
    await upsertMarkedComment(
      issues.github.client,
      issue,
      "repair",
      formatRepairRecord(state, text),
    );
    const need = await readRepairNeed(issues.github.client, issue);
    assert.equal(need?.kind, "resume");
    const before = issues.github.writes().length;
    assert.equal(
      await runRepair(
        issues.github.client,
        issue,
        need,
        testClock().clock,
        log,
        noDispatch,
      ),
      "released",
    );
    const writes = issues.github.writes().slice(before);
    assert.deepEqual(
      writes.map((call) => `${call.method} ${call.path}`),
      ["DELETE /repos/acme/app/issues/1/labels/pending"],
    );
  });

  it("resumes a wait for the time left, or at once after the reset", async () => {
    for (const [offset, expected] of [
      [30 * minute, 31 * minute],
      [-5 * minute, 0],
    ]) {
      const reset = new Date(start + offset).toISOString();
      const issues = await stopped(usageLimit(reset));
      const [pending] = issues.marked("pending");
      const state = {
        for: pendingDigest(pending.body),
        status: "repairing",
        action: "wait",
        handled: ["AGENT_USAGE_LIMIT"],
        reset,
      } as const;
      const text = { category: "c", reason: "r", evidence: "e", done: "d", advice: "a" };
      await upsertMarkedComment(
        issues.github.client,
        issue,
        "repair",
        formatRepairRecord(state, text),
      );
      const { clock, slept } = testClock();
      assert.equal(await repair(issues, clock), "released");
      assert.deepEqual(slept, [expected]);
    }
  });

  it("stops without a write when the Issue changes during the wait", async () => {
    const changes: Array<[string, (issues: FakeIssues) => void | Promise<void>]> = [
      [
        "a person removes pending",
        (issues) => {
          issues.main.labels.splice(issues.main.labels.indexOf("pending"), 1);
          unlabel(issues.main, "pending");
        },
      ],
      ["a person pauses the Issue", (issues) => void issues.main.labels.push("pause")],
      ["the Issue is closed", (issues) => void (issues.main.state = "closed")],
      [
        "a new stop rewrites the pending comment",
        (issues) => {
          const [pending] = issues.marked("pending");
          pending.body = pending.body.replace("runs/900", "runs/901");
        },
      ],
    ];
    for (const [name, change] of changes) {
      const reset = new Date(start + 10 * minute).toISOString();
      const issues = await stopped(usageLimit(reset));
      let writes = 0;
      const { clock } = testClock(async () => {
        await change(issues);
        writes = issues.github.writes().length;
      });
      assert.equal(await repair(issues, clock), "stopped", name);
      assert.equal(issues.github.writes().length, writes, name);
    }
  });

  it("fails unconfirmed when the read-back labels still have pending", async () => {
    const issues = await stopped(gitFailed());
    issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/pending", {
      data: [{ name: "pending" }],
    });
    const error = await rejection(repair(issues, testClock().clock));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.match(error.message, /remove pending/);
  });

  it("uses the system clock outside tests", async () => {
    assert.equal(typeof systemClock.now(), "number");
    assert.ok(systemClock.jobStart <= systemClock.now());
    await systemClock.sleep(0);
  });
});
