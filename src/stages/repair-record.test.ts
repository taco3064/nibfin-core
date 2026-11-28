import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  formatDecision,
  formatRepairRecord,
  parseDecision,
  parseRepairRecord,
  pendingDigest,
  type RepairState,
  repairStatus,
  type RepairStatusInput,
} from "./repair-record.ts";

const text = {
  category: "external temporary problem",
  reason: "It looks temporary.",
  evidence: "code `STAGE_GIT_FAILED`",
  done: "Removed `pending`.",
  advice: "None needed.",
};

const pendingBody = "<!-- nibfin:pending -->\nNibfin stopped and needs a person.";
const digest = pendingDigest(pendingBody);

describe("repair record", () => {
  it("digests the exact body with SHA-256", () => {
    const full = createHash("sha256").update(pendingBody).digest("hex");
    assert.equal(digest, full.slice(0, 16));
    assert.notEqual(pendingDigest(`${pendingBody} `), digest);
  });

  it("round-trips the state line and shows the R4.49 lines", () => {
    const states: RepairState[] = [
      {
        for: digest,
        status: "repairing",
        action: "retry",
        handled: ["STAGE_GIT_FAILED"],
      },
      {
        for: digest,
        status: "repairing",
        action: "wait",
        handled: ["STAGE_GIT_FAILED", "AGENT_USAGE_LIMIT"],
        reset: "2026-11-27T18:00:00Z",
      },
      { for: digest, status: "needs-person", action: "advice", handled: [] },
    ];
    for (const state of states) {
      const body = formatRepairRecord(state, text);
      assert.deepEqual(parseRepairRecord(body), state);
      assert.deepEqual(parseRepairRecord(`<!-- nibfin:repair -->\n${body}`), state);
      assert.ok(!body.split("\n")[0].slice(4, -3).includes("--"));
    }
    const body = formatRepairRecord(states[0], text);
    assert.equal(
      body.split("\n")[0],
      `<!-- nibfin:repair-state for=${digest} status=repairing action=retry ` +
        "handled=STAGE_GIT_FAILED -->",
    );
    for (const line of [
      "- Category: external temporary problem",
      "- Reason: It looks temporary.",
      "- Evidence: code `STAGE_GIT_FAILED`",
      "- Done: Removed `pending`.",
      "- Advice: None needed.",
    ]) {
      assert.ok(body.includes(`\n${line}`), line);
    }
  });

  it("round-trips the repair agent's actions and shows details last (#778)", () => {
    for (const [status, action] of [
      ["repairing", "agent"],
      ["repairing", "rerun"],
      ["repairing", "amend"],
      ["waiting-for-choice", "options"],
    ] as const) {
      const state: RepairState = { for: digest, status, action, handled: ["NONE"] };
      assert.deepEqual(parseRepairRecord(formatRepairRecord(state, text)), state);
    }
    const state: RepairState = {
      for: digest,
      status: "waiting-for-choice",
      action: "options",
      handled: [],
    };
    const body = formatRepairRecord(state, {
      ...text,
      details: "\n### Options\n\n1. A\n",
    });
    assert.ok(body.endsWith("- Advice: None needed.\n\n### Options\n\n1. A"));
  });

  it("refuses to write an invalid state", () => {
    const bad = { for: "x", status: "repairing", action: "retry", handled: [] } as const;
    assert.throws(() => formatRepairRecord(bad, text), TypeError);
  });

  it("reads a missing or unknown state line as no record", () => {
    const line = (rest: string) => `<!-- nibfin:repair-state for=${digest} ${rest} -->`;
    for (const body of [
      "",
      "<!-- nibfin:repair -->",
      "Some text",
      line("status=done action=retry handled="),
      line("status=repairing action=jump handled="),
      line("status=repairing action=wait handled=AGENT_USAGE_LIMIT"),
    ]) {
      assert.equal(parseRepairRecord(body), undefined, body);
    }
    assert.deepEqual(
      parseRepairRecord(line("status=waiting-for-choice action=advice handled=A,,B")),
      {
        for: digest,
        status: "waiting-for-choice",
        action: "advice",
        handled: ["A", "B"],
      },
    );
  });
});

describe("repairStatus", () => {
  const record = (status: RepairState["status"], forDigest = digest): RepairState => ({
    for: forDigest,
    status,
    action: "retry",
    handled: [],
  });
  const input = (overrides: Partial<RepairStatusInput>): RepairStatusInput => ({
    hasPendingLabel: true,
    pendingComment: { body: pendingBody, updatedAt: "2026-11-27T10:00:00Z" },
    lastUnlabeledPendingAt: null,
    record: record("repairing"),
    ...overrides,
  });

  it("is null without the pending label", () => {
    assert.equal(repairStatus(input({ hasPendingLabel: false })), null);
  });

  it("gives the record's status when it covers the current comment", () => {
    assert.equal(repairStatus(input({})), "repairing");
    const later = { lastUnlabeledPendingAt: "2026-11-27T09:59:59Z" };
    assert.equal(repairStatus(input(later)), "repairing");
    const choice = input({ record: record("waiting-for-choice") });
    assert.equal(repairStatus(choice), "waiting-for-choice");
  });

  it("is needs-person without a record or a current comment", () => {
    assert.equal(repairStatus(input({ record: null })), "needs-person");
    assert.equal(repairStatus(input({ record: undefined })), "needs-person");
    assert.equal(repairStatus(input({ pendingComment: null })), "needs-person");
  });

  it("is needs-person when the record covers another body (a new stop)", () => {
    const other = input({ record: record("repairing", pendingDigest("older stop")) });
    assert.equal(repairStatus(other), "needs-person");
  });

  it("is needs-person when pending came back without a new pending comment", () => {
    // After a successful retry Scope (or a workflow) adds `pending` again without
    // rewriting Nibfin's `pending` comment: the old `repairing` record still matches
    // its digest, but the comment predates the `unlabeled` event.
    for (const at of ["2026-11-27T10:00:00Z", "2026-11-27T10:00:01Z"]) {
      const stale = input({ lastUnlabeledPendingAt: at });
      assert.equal(repairStatus(stale), "needs-person", at);
    }
  });
});

describe("decision comment", () => {
  it("formats and parses the marked decision", () => {
    assert.equal(formatDecision(2), "<!-- nibfin:decision option=2 -->");
    assert.equal(parseDecision(formatDecision(2)), 2);
    assert.equal(parseDecision(`${formatDecision(13)}\nBecause.`), 13);
    assert.throws(() => formatDecision(0), TypeError);
    assert.throws(() => formatDecision(1.5), TypeError);
  });

  it("takes a body that is only a number", () => {
    assert.equal(parseDecision("  3 \n"), 3);
  });

  it("ignores anything else", () => {
    for (const body of [
      "",
      "option 3",
      "0",
      "3 please",
      "<!-- nibfin:decision option=0 -->",
      "Text\n<!-- nibfin:decision option=2 -->",
      "99999999999999999999",
    ]) {
      assert.equal(parseDecision(body), undefined, body);
    }
  });
});
