import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StageError } from "./errors.ts";
import { parseAgentResult, textField } from "./result.ts";

const outcomes = ["done", "blocked"] as const;
const block = (json: string, open = "```nibfin-result", close = "```") =>
  `${open}\n${json}\n${close}`;

function invalid(message: string, reason: string) {
  assert.throws(
    () => parseAgentResult(message, outcomes),
    (error: unknown) => {
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_RESULT_INVALID");
      assert.equal(
        error.message,
        `The agent result is invalid: ${reason}.\nFinal message:\n${message}`,
      );
      return true;
    },
  );
}

describe("parseAgentResult", () => {
  it("reads the last complete block", () => {
    const message = [
      block('{"outcome": "blocked", "reason": "old"}'),
      "Then:",
      block('{\r\n  "outcome": "done",\r\n  "note": "```"\r\n}'),
      "```nibfin-result",
      '{"outcome": "blocked"}',
    ].join("\n");
    assert.deepEqual(parseAgentResult(message, outcomes), {
      outcome: "done",
      note: "```",
    });
  });

  for (const [name, message] of [
    ["no block", "All done."],
    ["an opening line with more text", block('{"outcome":"done"}', "```nibfin-result x")],
    ["an indented opening line", block('{"outcome":"done"}', " ```nibfin-result")],
    ["another language", block('{"outcome":"done"}', "```json")],
    ["no closing line", '```nibfin-result\n{"outcome":"done"}\n``` '],
  ]) {
    it(`finds no result in ${name}`, () => {
      invalid(message, "no nibfin-result block");
    });
  }

  it("rejects text that is not JSON", () => {
    invalid(block("outcome: done"), "the nibfin-result block is not JSON");
  });

  for (const json of ["[1]", "null", '"done"']) {
    it(`rejects the JSON ${json}`, () => {
      invalid(block(json), "the nibfin-result block is not a JSON object");
    });
  }

  for (const json of ["{}", '{"outcome": "ready"}', '{"outcome": 1}']) {
    it(`rejects the outcome of ${json}`, () => {
      invalid(block(json), 'outcome must be one of "done", "blocked"');
    });
  }
});

describe("textField", () => {
  it("returns a non-empty string", () => {
    assert.equal(textField({ reason: "x" }, "reason", "m"), "x");
  });

  for (const value of [undefined, "", "  ", 3]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.throws(() => textField({ reason: value }, "reason", "m"), {
        code: "STAGE_RESULT_INVALID",
        message:
          "The agent result is invalid: reason must be a non-empty string.\n" +
          "Final message:\nm",
      });
    });
  }
});
