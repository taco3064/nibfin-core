import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { noNextAction, writeNextAction } from "./next.ts";

describe("writeNextAction", () => {
  it("writes the action as JSON", async () => {
    const dir = await makeTempDir("next-");
    const nextFile = join(dir, "next.json");
    await writeNextAction({ nextFile }, { stage: "review", reason: null });
    assert.deepEqual(JSON.parse(await readFile(nextFile, "utf8")), {
      stage: "review",
      reason: null,
    });
    await writeNextAction({ nextFile }, noNextAction);
    assert.equal(await readFile(nextFile, "utf8"), '{"stage":null,"reason":null}\n');
  });

  it("does nothing without a next-action file", async () => {
    const dir = await makeTempDir("next-");
    await writeNextAction({}, noNextAction);
    assert.deepEqual(await readdir(dir), []);
  });
});
