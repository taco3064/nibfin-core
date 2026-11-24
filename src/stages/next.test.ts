import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import { noNextAction, readNextAction, writeNextAction } from "./next.ts";

describe("writeNextAction", () => {
  it("writes the action and whether the run progressed as JSON", async () => {
    const dir = await makeTempDir("next-");
    const nextFile = join(dir, "next.json");
    await writeNextAction({ nextFile }, { stage: "review", reason: null }, true);
    assert.deepEqual(JSON.parse(await readFile(nextFile, "utf8")), {
      stage: "review",
      reason: null,
      progressed: true,
    });
    await writeNextAction({ nextFile }, noNextAction, false);
    assert.equal(
      await readFile(nextFile, "utf8"),
      '{"stage":null,"reason":null,"progressed":false}\n',
    );
  });

  it("writes a Deliver fix and the Issues to wake", async () => {
    const dir = await makeTempDir("next-");
    const nextFile = join(dir, "next.json");
    await writeNextAction({ nextFile }, { stage: "deliver", reason: "review" }, true);
    assert.equal(
      await readFile(nextFile, "utf8"),
      '{"stage":"deliver","reason":"review","progressed":true}\n',
    );
    const wake = [{ repo: "acme/lib", issue: 3, extra: true }];
    await writeNextAction({ nextFile }, { stage: null, reason: null, wake }, true);
    assert.deepEqual(JSON.parse(await readFile(nextFile, "utf8")), {
      stage: null,
      reason: null,
      wake: [{ repo: "acme/lib", issue: 3 }],
      progressed: true,
    });
  });

  it("writes a request for the Shape stage", async () => {
    const dir = await makeTempDir("next-");
    const nextFile = join(dir, "next.json");
    await writeNextAction({ nextFile }, { stage: "shape", reason: null }, false);
    assert.equal(
      await readFile(nextFile, "utf8"),
      '{"stage":"shape","reason":null,"progressed":false}\n',
    );
  });

  it("does nothing without a next-action file", async () => {
    const dir = await makeTempDir("next-");
    await writeNextAction({}, noNextAction, false);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("readNextAction", () => {
  it("reads back what a stage wrote", async () => {
    const dir = await makeTempDir("next-");
    const nextFile = join(dir, "next.json");
    const wake = [{ repo: "acme/lib", issue: 3 }];
    await writeNextAction({ nextFile }, { stage: null, reason: null, wake }, true);
    assert.deepEqual(await readNextAction(nextFile), {
      stage: null,
      reason: null,
      wake,
      progressed: true,
    });
    const fix = { stage: "deliver" as const, reason: "ci-failure" as const };
    await writeNextAction({ nextFile }, fix, false);
    assert.deepEqual(await readNextAction(nextFile), { ...fix, progressed: false });
  });

  for (const [name, text] of [
    ["not JSON", "{"],
    ["null", "null"],
    ["an unknown stage", '{"stage":"accept","reason":null,"progressed":true}'],
    ["a missing stage", '{"reason":null,"progressed":true}'],
    ["an unknown reason", '{"stage":"deliver","reason":"x","progressed":true}'],
    ["a missing reason", '{"stage":"deliver","progressed":true}'],
    ["no progressed", '{"stage":null,"reason":null}'],
    ["a wake object", '{"stage":null,"reason":null,"wake":{},"progressed":true}'],
    [
      "a bad wake repo",
      '{"stage":null,"reason":null,"wake":[{"repo":"x","issue":1}],"progressed":true}',
    ],
    [
      "a bad wake issue",
      '{"stage":null,"reason":null,"wake":[{"repo":"a/b","issue":0}],"progressed":true}',
    ],
    [
      "a wake without an issue",
      '{"stage":null,"reason":null,"wake":[{"repo":"a/b"}],"progressed":true}',
    ],
    ["a null wake entry", '{"stage":null,"reason":null,"wake":[null],"progressed":true}'],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const dir = await makeTempDir("next-");
      const nextFile = join(dir, "next.json");
      await writeFile(nextFile, text);
      const error = await rejection(readNextAction(nextFile));
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_INPUT_INVALID");
    });
  }
});
