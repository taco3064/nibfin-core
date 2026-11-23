import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { usage } from "./run.ts";
import { readVersion } from "./version.ts";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

function runEntry(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

describe("nibfin entry", () => {
  it("prints the version and exits 0", () => {
    const result = runEntry("--version");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${readVersion()}\n`);
  });

  it("prints usage to stderr and exits 1 for unknown input", () => {
    const result = runEntry("--unknown");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, usage);
  });
});
