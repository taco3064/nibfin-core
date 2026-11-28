import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshReads, upsertMarkedComment } from "../github/index.ts";
import { StageError } from "./errors.ts";
import { type FakeIssues, fakeIssue, fakeIssues, unlabel } from "./fake-job.test.ts";
import {
  askPersonOnce,
  JobFailedError,
  pendingBody,
  readPendingCause,
  requestPerson,
  temporarySentence,
} from "./pending.ts";
import {
  amendmentNote,
  formatRepairRecord,
  pendingDigest,
  type RepairAction,
  type RepairStatus,
} from "./repair-record.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const url = "https://github.com/acme/runner/actions/runs/900";
const other = "https://github.com/acme/runner/actions/runs/901";
const gitFailed = new StageError("STAGE_GIT_FAILED", "git failed");
const recordText = { category: "x", reason: "x", evidence: "x", done: "x", advice: "x" };

function pendingComment(issues: FakeIssues) {
  const comments = issues.marked("pending");
  assert.equal(comments.length, 1);
  return comments[0];
}

/** An Issue that stopped on `error` in run `run`: its `pending` comment and label. */
async function stopped(error: unknown = gitFailed, run = url): Promise<FakeIssues> {
  const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
  await requestPerson(issues.github.client, issue, error, run);
  return issues;
}

/** Writes Nibfin's repair record for the current `pending` comment. */
async function recordRepair(
  issues: FakeIssues,
  action: RepairAction,
  status: RepairStatus = "repairing",
) {
  const state = {
    for: pendingDigest(pendingComment(issues).body),
    status,
    action,
    handled: [],
  };
  await upsertMarkedComment(
    issues.github.client,
    issue,
    "repair",
    formatRepairRecord(state, recordText),
  );
  freshReads(issues.github.client);
}

function once(
  issues: FakeIssues,
  error: unknown,
  run: string | undefined,
  stage?: string,
) {
  return askPersonOnce(issues.github.client, issue, error, run, stage);
}

describe("JobFailedError", () => {
  it("names the stage and is not temporary", () => {
    const error = new JobFailedError("deliver");
    assert.equal(error.code, "JOB_FAILED");
    assert.equal(error.name, "JobFailedError");
    assert.equal(error.stage, "deliver");
    assert.equal(error.amendment, false);
    assert.equal(
      error.message,
      "The `deliver` Job failed before Nibfin could report a cause (checkout, image " +
        "pull, container start or clean up); see the run log.",
    );
    const body = pendingBody(error, url);
    assert.deepEqual(readPendingCause(body), {
      code: "JOB_FAILED",
      run: url,
      temporary: false,
      reset: undefined,
      fromRepair: false,
    });
    assert.ok(!body.includes(temporarySentence));
  });

  it("adds the amendment note when asked", () => {
    const error = new JobFailedError("repair", true);
    assert.equal(error.amendment, true);
    assert.ok(error.message.endsWith(`see the run log. ${amendmentNote}`));
  });
});

describe("askPersonOnce for a Job that is not the repair stage", () => {
  it("adds pending with JOB_FAILED when nothing was reported", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    assert.equal(await once(issues, new JobFailedError("route"), url, "route"), true);
    assert.ok(issues.main.labels.includes("pending"));
    const { body } = pendingComment(issues);
    assert.ok(body.includes("- Code: `JOB_FAILED`\n"));
    assert.ok(body.includes(`- Run: ${url}\n`));
    assert.ok(body.includes("The `route` Job failed before Nibfin could report"));
    assert.ok(!body.includes("- Stage:"));
    assert.match(body, /Remove the `pending` label to continue\.$/);
  });

  it("leaves a standing stop as it is", async () => {
    const issues = await stopped();
    const before = pendingComment(issues).body;
    assert.equal(
      await once(issues, new JobFailedError("deliver"), other, "deliver"),
      false,
    );
    assert.equal(pendingComment(issues).body, before);
    assert.ok(issues.main.labels.includes("pending"));
  });

  it("only adds pending when Core already reported this run", async () => {
    const issues = await stopped();
    const before = pendingComment(issues).body;
    // The label write of Core's own report failed.
    issues.main.labels.splice(issues.main.labels.indexOf("pending"), 1);
    freshReads(issues.github.client);
    assert.equal(await once(issues, new JobFailedError("shape"), url, "shape"), true);
    assert.ok(issues.main.labels.includes("pending"));
    assert.equal(pendingComment(issues).body, before);
    assert.equal(readPendingCause(before).code, "STAGE_GIT_FAILED");
  });

  it("rewrites this run's comment once a person removed pending", async () => {
    const issues = await stopped();
    issues.main.labels.splice(issues.main.labels.indexOf("pending"), 1);
    unlabel(issues.main, "pending");
    freshReads(issues.github.client);
    assert.equal(await once(issues, new JobFailedError("shape"), url, "shape"), true);
    assert.equal(readPendingCause(pendingComment(issues).body).code, "JOB_FAILED");
    assert.ok(issues.main.labels.includes("pending"));
  });

  it("writes JOB_FAILED over a comment of another run", async () => {
    const issues = await stopped(gitFailed, other);
    issues.main.labels.splice(issues.main.labels.indexOf("pending"), 1);
    freshReads(issues.github.client);
    assert.equal(await once(issues, new JobFailedError("finish"), url, "finish"), true);
    const cause = readPendingCause(pendingComment(issues).body);
    assert.equal(cause.code, "JOB_FAILED");
    assert.equal(cause.run, url);
  });

  it("does not match a comment without a run when the run is unknown", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    await requestPerson(issues.github.client, issue, gitFailed, undefined);
    issues.main.labels.splice(issues.main.labels.indexOf("pending"), 1);
    freshReads(issues.github.client);
    assert.equal(await once(issues, new JobFailedError("route"), undefined), true);
    const { body } = pendingComment(issues);
    assert.equal(readPendingCause(body).code, "JOB_FAILED");
    assert.ok(body.includes("- Run: unknown\n"));
  });

  it("passes another error through as it is", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    assert.equal(await once(issues, gitFailed, url), true);
    const cause = readPendingCause(pendingComment(issues).body);
    assert.equal(cause.code, "STAGE_GIT_FAILED");
    assert.equal(cause.temporary, true);
  });
});

describe("askPersonOnce for a repair Job", () => {
  const repairFailed = () => new JobFailedError("repair");

  it("does nothing without pending", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    assert.equal(await once(issues, repairFailed(), other, "repair"), false);
    assert.deepEqual(issues.marked("pending"), []);
    assert.ok(!issues.main.labels.includes("pending"));
  });

  it("does nothing without a repair record", async () => {
    const issues = await stopped();
    const before = pendingComment(issues).body;
    assert.equal(await once(issues, repairFailed(), other, "repair"), false);
    assert.equal(pendingComment(issues).body, before);
  });

  it("ends the stop while an agent record covers it (R4.50)", async () => {
    const issues = await stopped();
    await recordRepair(issues, "agent");
    assert.equal(await once(issues, repairFailed(), other, "repair"), true);
    const { body } = pendingComment(issues);
    const cause = readPendingCause(body);
    assert.equal(cause.code, "JOB_FAILED");
    assert.equal(cause.run, other);
    assert.equal(cause.fromRepair, true);
    assert.ok(!body.includes(amendmentNote));
    assert.ok(issues.main.labels.includes("pending"));
  });

  it("says an amendment may be partly applied under an amend record", async () => {
    const issues = await stopped();
    await recordRepair(issues, "amend");
    assert.equal(await once(issues, repairFailed(), other, "repair"), true);
    const { body } = pendingComment(issues);
    assert.ok(body.includes(amendmentNote));
    assert.equal(readPendingCause(body).fromRepair, true);
  });

  it("keeps another error's message under an amend record", async () => {
    const issues = await stopped();
    await recordRepair(issues, "amend");
    assert.equal(await once(issues, gitFailed, other, "repair"), true);
    const { body } = pendingComment(issues);
    assert.equal(readPendingCause(body).code, "STAGE_GIT_FAILED");
    assert.ok(!body.includes(amendmentNote));
  });

  const finished: [string, RepairAction, RepairStatus][] = [
    ["a rerun record", "rerun", "repairing"],
    ["a record that needs a person", "advice", "needs-person"],
    ["a record waiting for a choice", "options", "waiting-for-choice"],
  ];
  for (const [name, action, status] of finished) {
    it(`does nothing under ${name}`, async () => {
      const issues = await stopped();
      await recordRepair(issues, action, status);
      const before = pendingComment(issues).body;
      assert.equal(await once(issues, repairFailed(), other, "repair"), false);
      assert.equal(pendingComment(issues).body, before);
    });
  }

  it("does nothing once Core rewrote the stop for the repair stage", async () => {
    const issues = await stopped();
    await recordRepair(issues, "agent");
    await requestPerson(issues.github.client, issue, gitFailed, other, "repair");
    freshReads(issues.github.client);
    const before = pendingComment(issues).body;
    assert.equal(await once(issues, repairFailed(), other, "repair"), false);
    assert.equal(pendingComment(issues).body, before);
    assert.equal(readPendingCause(before).code, "STAGE_GIT_FAILED");
  });
});
