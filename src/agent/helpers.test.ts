import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { AgentError } from "./errors.ts";
import { makeTempDir, makeWorkspace } from "./fake-cli.test.ts";
import { isDirectory, readOptionalFile } from "./fs.ts";
import { gitPath } from "./git-path.ts";
import { isRecord, parseJsonRecord, stringField } from "./json.ts";
import { describeExit } from "./process.ts";

let root: string;
before(async () => {
  root = await makeTempDir("helpers-");
});
after(() => rm(root, { recursive: true, force: true }));

describe("AgentError", () => {
  it("keeps the code, exit code, login command, output and cause", () => {
    const cause = new Error("inner");
    const error = new AgentError("AGENT_LOGIN_REQUIRED", "msg", {
      exitCode: 1,
      loginCommand: "login",
      output: "out",
      cause,
    });
    assert.equal(error.name, "AgentError");
    assert.equal(error.message, "msg");
    assert.equal(error.code, "AGENT_LOGIN_REQUIRED");
    assert.equal(error.exitCode, 1);
    assert.equal(error.loginCommand, "login");
    assert.equal(error.output, "out");
    assert.equal(error.cause, cause);
    assert.ok(error instanceof Error);
  });
});

describe("json helpers", () => {
  it("recognizes only plain objects as records", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("x"), false);
  });

  it("parses JSON objects and rejects other text", () => {
    assert.deepEqual(parseJsonRecord('{"a":1}'), { a: 1 });
    assert.equal(parseJsonRecord("[1]"), undefined);
    assert.equal(parseJsonRecord("not json"), undefined);
  });

  it("reads string fields only", () => {
    assert.equal(stringField({ a: "x" }, "a"), "x");
    assert.equal(stringField({ a: 1 }, "a"), undefined);
  });
});

describe("fs helpers", () => {
  it("reads an existing file and returns undefined for a missing one", async () => {
    const file = join(root, "present.txt");
    await writeFile(file, "text");
    assert.equal(await readOptionalFile(file), "text");
    assert.equal(await readOptionalFile(join(root, "missing.txt")), undefined);
  });

  it("rethrows read errors other than absence", async () => {
    const dir = join(root, "a-directory");
    await mkdir(dir);
    await assert.rejects(readOptionalFile(dir), { code: "EISDIR" });
  });

  it("tells directories from files and absent paths", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "");
    assert.equal(isDirectory(root), true);
    assert.equal(isDirectory(file), false);
    assert.equal(isDirectory(join(root, "absent")), false);
  });
});

describe("gitPath", () => {
  it("resolves a path inside the repository's git directory", async () => {
    const workspace = await makeWorkspace(root);
    assert.equal(
      await gitPath(workspace, "info/exclude"),
      resolve(workspace, ".git/info/exclude"),
    );
  });
});

describe("describeExit", () => {
  it("names the exit code, or the signal when there is none", () => {
    assert.equal(describeExit({ exitCode: 3, signal: null }), "exit code 3");
    assert.equal(describeExit({ exitCode: null, signal: "SIGKILL" }), "signal SIGKILL");
  });
});
