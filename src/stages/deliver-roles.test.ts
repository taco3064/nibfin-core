import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptorRole,
  parseAcceptorResult,
  parseWriterResult,
  writerRole,
} from "./deliver-roles.ts";
import { StageError } from "./errors.ts";
import { agentResult } from "./fake-job.test.ts";

function invalid(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_RESULT_INVALID");
    assert.match(error.message, pattern);
    return true;
  });
}

describe("Deliver roles", () => {
  it("runs the Writer writable and the Acceptor read-only", () => {
    assert.deepEqual(
      [writerRole.skill, writerRole.readOnly, acceptorRole.skill, acceptorRole.readOnly],
      ["deliver", false, "accept", true],
    );
    assert.match(writerRole.resultFormat, /"outcome": "done"/);
    assert.match(acceptorRole.resultFormat, /"outcome": "defects"/);
  });

  it("parses the Writer's result", () => {
    assert.deepEqual(parseWriterResult(agentResult({ outcome: "done" })), {
      outcome: "done",
    });
    assert.deepEqual(
      parseWriterResult(agentResult({ outcome: "blocked", reason: "r" })),
      {
        outcome: "blocked",
        reason: "r",
      },
    );
    invalid(() => parseWriterResult(agentResult({ outcome: "blocked" })), /reason/);
    invalid(() => parseWriterResult(agentResult({ outcome: "pass" })), /outcome/);
  });

  it("parses a Writer's report that the Shape is wrong", () => {
    assert.match(
      writerRole.resultFormat,
      /"outcome": "shape-wrong", "reason": "<the exact/,
    );
    assert.deepEqual(
      parseWriterResult(agentResult({ outcome: "shape-wrong", reason: "Clause 2" })),
      { outcome: "shape-wrong", reason: "Clause 2" },
    );
    for (const reason of [undefined, "", "  ", 3]) {
      invalid(
        () => parseWriterResult(agentResult({ outcome: "shape-wrong", reason })),
        /reason must be a non-empty string/,
      );
    }
  });

  it("parses the Acceptor's result", () => {
    assert.deepEqual(parseAcceptorResult(agentResult({ outcome: "pass" })), {
      outcome: "pass",
    });
    assert.deepEqual(
      parseAcceptorResult(agentResult({ outcome: "defects", defects: ["a", "b"] })),
      { outcome: "defects", defects: ["a", "b"] },
    );
    assert.deepEqual(
      parseAcceptorResult(agentResult({ outcome: "blocked", reason: "no evidence" })),
      { outcome: "blocked", reason: "no evidence" },
    );
    for (const defects of [[], [" "], [1], "a", undefined]) {
      invalid(
        () => parseAcceptorResult(agentResult({ outcome: "defects", defects })),
        /defects must be a non-empty list/,
      );
    }
  });
});
