import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

describe("Action entry", () => {
  it("prints the failure to stderr and exits 1 without a command", () => {
    // No INPUT_* of the test's own environment reaches the Action.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("INPUT_")),
    );
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "nibfin: STAGE_INPUT_INVALID: INPUT_COMMAND is missing\n",
    );
  });
});
