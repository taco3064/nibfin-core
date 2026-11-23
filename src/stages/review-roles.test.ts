import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import { agentResult } from "./fake-job.test.ts";
import { parseReviewerResult, reviewerRole } from "./review-roles.ts";

const head = "a".repeat(40);

function parse(value: Record<string, unknown>) {
  return parseReviewerResult(agentResult({ reviewedHead: head, ...value }), head);
}

describe("parseReviewerResult", () => {
  it("reads each outcome with the reviewed head", () => {
    assert.deepEqual(parse({ outcome: "clean" }), {
      outcome: "clean",
      reviewedHead: head,
    });
    assert.deepEqual(parse({ outcome: "problems", problems: ["A"] }), {
      outcome: "problems",
      reviewedHead: head,
      problems: ["A"],
    });
    assert.deepEqual(parse({ outcome: "blocked", reason: "R" }), {
      outcome: "blocked",
      reviewedHead: head,
      reason: "R",
    });
  });

  for (const [name, value] of [
    ["another head", { outcome: "clean", reviewedHead: "b".repeat(40) }],
    ["no head", { outcome: "clean", reviewedHead: "" }],
    ["no problems", { outcome: "problems", problems: [] }],
    ["a blank problem", { outcome: "problems", problems: [" "] }],
    ["problems that are not a list", { outcome: "problems", problems: "A" }],
    ["a blocked result without reason", { outcome: "blocked" }],
    ["an unknown outcome", { outcome: "approved" }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const error = await rejection(Promise.resolve().then(() => parse(value)));
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_RESULT_INVALID");
    });
  }

  it("is a read-only role of the shape skill", () => {
    assert.equal(reviewerRole.readOnly, true);
    assert.equal(reviewerRole.skill, "shape");
    assert.match(reviewerRole.resultFormat, /Disclosure/);
  });
});
