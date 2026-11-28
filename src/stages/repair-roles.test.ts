import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StageError } from "./errors.ts";
import { agentResult } from "./fake-job.test.ts";
import { parseRepairResult, repairClasses, repairRole } from "./repair-roles.ts";

const context = {
  body: "Body.\nOrigin: https://github.com/acme/app/issues/3",
  guard: false,
};
const base = { summary: "The cause; next step.", evidence: ["a fact (job log)"] };
const options = [
  { title: "One", consequence: "c1", issueChange: "i1", recommended: true },
  { title: "Two", consequence: "c2", issueChange: "i2", recommended: false },
];
const step = {
  text: "Remove pending.",
  command: "gh issue edit 1 --remove-label pending",
};

function parse(value: unknown, given = context) {
  return parseRepairResult(agentResult(value), given);
}

function rejects(value: unknown, pattern: RegExp, given = context) {
  assert.throws(
    () => parse(value, given),
    (error: unknown) =>
      error instanceof StageError &&
      error.code === "STAGE_RESULT_INVALID" &&
      pattern.test(error.message),
    pattern.source,
  );
}

describe("repairRole", () => {
  it("is the read-only repair role with the four outcomes", () => {
    assert.equal(repairRole.skill, "repair");
    assert.equal(repairRole.readOnly, true);
    for (const outcome of ["RERUN", "AMEND", "DECIDE", "FOLLOW_UP"]) {
      assert.ok(repairRole.resultFormat.includes(`"outcome": "${outcome}"`), outcome);
    }
    assert.match(repairRole.resultFormat, /Visibility section/);
    assert.equal(Object.keys(repairClasses).join(""), "ABCDEF");
  });
});

describe("parseRepairResult", () => {
  it("reads each outcome", () => {
    assert.deepEqual(parse({ ...base, class: "C", outcome: "RERUN" }), {
      class: "C",
      summary: "The cause; next step.",
      evidence: ["a fact (job log)"],
      outcome: "RERUN",
    });
    const amend = parse({
      ...base,
      class: "D",
      outcome: "AMEND",
      body: "New.\nOrigin: https://github.com/acme/app/issues/3",
      changeSummary: "Fixed the path.",
    });
    assert.deepEqual(amend.outcome === "AMEND" && amend.blockedBy, []);
    const edge = parse({
      ...base,
      class: "D",
      outcome: "AMEND",
      blockedBy: ["https://github.com/acme/app/issues/9"],
      changeSummary: "Added the edge.",
    });
    assert.equal(edge.outcome === "AMEND" && edge.body, null);
    const decide = parse({ ...base, class: "E", outcome: "DECIDE", options });
    assert.deepEqual(decide.outcome === "DECIDE" && decide.options, options);
    const follow = parse({
      ...base,
      class: "B",
      outcome: "FOLLOW_UP",
      steps: [step, { text: "Read it.", link: "https://example.com/x" }],
      bugReport: { title: "T", body: "B" },
    });
    assert.deepEqual(follow.outcome === "FOLLOW_UP" && follow.bugReport, {
      title: "T",
      body: "B",
    });
    const plain = parse({
      ...base,
      class: "E",
      outcome: "FOLLOW_UP",
      steps: [step],
      bugReport: null,
    });
    assert.equal(plain.outcome === "FOLLOW_UP" && plain.bugReport, undefined);
  });

  it("rejects a bad class, summary or evidence", () => {
    rejects({ ...base, class: "G", outcome: "RERUN" }, /class must be one of/);
    rejects({ ...base, class: 3, outcome: "RERUN" }, /class must be one of/);
    rejects({ ...base, class: "A", outcome: "RERUN", summary: "two\nlines" }, /one line/);
    rejects({ ...base, class: "A", outcome: "RERUN", summary: "" }, /summary/);
    rejects({ ...base, class: "A", outcome: "RERUN", evidence: [] }, /evidence must be/);
    rejects(
      { ...base, class: "A", outcome: "RERUN", evidence: [""] },
      /evidence must be/,
    );
    rejects({ ...base, class: "A", outcome: "OTHER" }, /outcome must be one of/);
  });

  it("rejects an outcome with a class it does not take", () => {
    for (const kind of ["D", "E", "F"]) {
      rejects({ ...base, class: kind, outcome: "RERUN" }, /RERUN does not take class/);
    }
    rejects(
      { ...base, class: "E", outcome: "AMEND", body: "x", changeSummary: "s" },
      /AMEND does not take class E/,
    );
    rejects({ ...base, class: "D", outcome: "DECIDE", options }, /DECIDE does not take/);
  });

  it("rejects Rerun and Amend under the guard (R4.47)", () => {
    const guarded = { ...context, guard: true };
    rejects({ ...base, class: "A", outcome: "RERUN" }, /already received/, guarded);
    rejects(
      { ...base, class: "D", outcome: "AMEND", body: "x", changeSummary: "s" },
      /already received/,
      guarded,
    );
    assert.equal(
      parse({ ...base, class: "E", outcome: "DECIDE", options }, guarded).outcome,
      "DECIDE",
    );
  });

  it("rejects an amendment that is empty, malformed or drops the origin line", () => {
    const amend = { ...base, class: "D", outcome: "AMEND", changeSummary: "s" };
    rejects({ ...amend, body: null }, /needs a body or a blockedBy/);
    rejects({ ...amend, body: 3 }, /body must be a string or null/);
    rejects(
      { ...amend, body: null, blockedBy: ["#9"] },
      /blockedBy must hold Issue URLs/,
    );
    rejects({ ...amend, body: null, blockedBy: "x" }, /blockedBy must be a list/);
    rejects({ ...amend, body: "Body without it." }, /keep every Origin: line/);
    rejects({ ...amend, body: "x", changeSummary: "" }, /changeSummary/);
  });

  it("rejects 1 or 5 options, two recommended, or a bad option", () => {
    const decide = { ...base, class: "E", outcome: "DECIDE" };
    rejects({ ...decide, options: [options[0]] }, /2 to 4 options/);
    rejects(
      { ...decide, options: [...options, ...options, options[1]] },
      /2 to 4 options/,
    );
    rejects(
      { ...decide, options: [options[0], { ...options[1], recommended: true }] },
      /exactly one option/,
    );
    rejects(
      {
        ...decide,
        options: [options[0], { ...options[1], recommended: false }].map((o) => ({
          ...o,
          recommended: false,
        })),
      },
      /exactly one option/,
    );
    rejects(
      { ...decide, options: [options[0], { ...options[1], recommended: "no" }] },
      /recommended: true or false/,
    );
    rejects({ ...decide, options: [options[0], { ...options[1], title: "" }] }, /title/);
    rejects({ ...decide, options: "x" }, /options must be a list of objects/);
    rejects({ ...decide, options: [1, 2] }, /options must be a list of objects/);
  });

  it("rejects steps without a link or command, bad links, bug report mismatches", () => {
    const follow = { ...base, class: "F", outcome: "FOLLOW_UP" };
    rejects({ ...follow, steps: [] }, /at least one step/);
    rejects({ ...follow, steps: [{ text: "Do it." }] }, /a link or a command/);
    rejects(
      { ...follow, steps: [{ text: "Do it.", link: "javascript:x" }] },
      /https URL/,
    );
    rejects({ ...follow, steps: [{ text: "", command: "x" }] }, /text/);
    rejects(
      { ...follow, steps: [step], bugReport: { title: "t", body: "b" } },
      /only for class B/,
    );
    rejects({ ...follow, class: "B", steps: [step] }, /class B needs a bugReport/);
    rejects(
      { ...follow, class: "B", steps: [step], bugReport: { title: "t", body: "" } },
      /body/,
    );
  });
});
