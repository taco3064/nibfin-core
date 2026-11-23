import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run, usage } from "./run.ts";
import { readVersion } from "./version.ts";

function capture(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("run", () => {
  it("prints the version for --version", () => {
    assert.deepEqual(capture(["--version"]), {
      code: 0,
      stdout: `${readVersion()}\n`,
      stderr: "",
    });
  });

  it("prints usage to stdout for --help", () => {
    assert.deepEqual(capture(["--help"]), { code: 0, stdout: usage, stderr: "" });
  });

  for (const args of [[], ["--unknown"], ["run"], ["--version", "--help"]]) {
    it(`prints usage to stderr and fails for ${JSON.stringify(args)}`, () => {
      assert.deepEqual(capture(args), { code: 1, stdout: "", stderr: usage });
    });
  }
});
