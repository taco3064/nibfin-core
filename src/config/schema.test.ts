import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "./errors.ts";
import { makeTempDir } from "./fixtures.test.ts";
import { parseNibfinConfig, readNibfinConfig } from "./schema.ts";

/** The built-in skills of Core's own `skills/` today. */
const skillNames = ["accept", "deliver", "scope", "shape"];

let root: string;
before(async () => {
  root = await makeTempDir("config-schema-");
});
after(() => rm(root, { recursive: true, force: true }));

function problemsOf(value: unknown): string[] {
  try {
    parseNibfinConfig(JSON.stringify(value), skillNames);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.code, "CONFIG_INVALID");
    const [heading, ...lines] = error.message.split("\n");
    assert.equal(heading, ".nibfin.json is invalid:");
    return lines.map((line) => line.replace(/^- /, ""));
  }
  assert.fail("expected CONFIG_INVALID");
}

describe("parseNibfinConfig", () => {
  it("accepts every supported setting", () => {
    const text = JSON.stringify({
      tools: { node: "22.15.0", python: "3.13.7", go: "1.24.2" },
      skills: {
        shape: { mode: "extend", path: "docs/shape.md" },
        deliver: { mode: "override", path: "deliver.md" },
        accept: { mode: "extend", path: "accept.md" },
      },
    });
    assert.deepEqual(parseNibfinConfig(text, skillNames), {
      tools: { node: "22.15.0", python: "3.13.7", go: "1.24.2" },
      skills: {
        shape: { mode: "extend", path: "docs/shape.md" },
        deliver: { mode: "override", path: "deliver.md" },
        accept: { mode: "extend", path: "accept.md" },
      },
    });
  });

  it("gives the defaults for an empty object and empty sections", () => {
    assert.deepEqual(parseNibfinConfig("{}", skillNames), { tools: {}, skills: {} });
    const empty = JSON.stringify({ tools: {}, skills: {} });
    assert.deepEqual(parseNibfinConfig(empty, skillNames), { tools: {}, skills: {} });
  });

  it("accepts a Go minor version and versions with zeros", () => {
    const text = JSON.stringify({ tools: { go: "1.20", node: "0.10.0" } });
    assert.deepEqual(parseNibfinConfig(text, skillNames).tools, {
      go: "1.20",
      node: "0.10.0",
    });
  });

  it("rejects malformed JSON and keeps the parser error", () => {
    assert.throws(
      () => parseNibfinConfig("{ tools: ", skillNames),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.code === "CONFIG_INVALID" &&
        error.message.startsWith(".nibfin.json is not valid JSON: ") &&
        error.cause instanceof SyntaxError,
    );
  });

  it("rejects a top level that is not an object", () => {
    assert.deepEqual(problemsOf([]), ["$: expected an object, got an array"]);
    assert.deepEqual(problemsOf(null), ["$: expected an object, got null"]);
    assert.deepEqual(problemsOf("x"), ["$: expected an object, got a string"]);
  });

  it("rejects unknown and removed top-level keys", () => {
    assert.deepEqual(
      problemsOf({ allowedDomains: [], writerBackend: "codex", extra: 1, "a-b": 2 }),
      [
        "$.allowedDomains: unknown key (removed from Nibfin)",
        "$.writerBackend: unknown key (removed from Nibfin)",
        "$.extra: unknown key",
        '$["a-b"]: unknown key',
      ],
    );
  });

  it("rejects tools that are not an object or not supported", () => {
    assert.deepEqual(problemsOf({ tools: [] }), [
      "$.tools: expected an object, got an array",
    ]);
    assert.deepEqual(problemsOf({ tools: { ruby: "3.4.0", allowedDomains: [] } }), [
      "$.tools.ruby: unknown key",
      "$.tools.allowedDomains: unknown key",
    ]);
  });

  it("rejects versions that are not exact releases", () => {
    const tools = {
      node: "22",
      python: "3.13",
      go: "1",
    };
    assert.deepEqual(problemsOf({ tools }), [
      '$.tools.node: expected a version "x.y.z", got "22"',
      '$.tools.python: expected a version "x.y.z", got "3.13"',
      '$.tools.go: expected a version "x.y.z" or "x.y", got "1"',
    ]);
    assert.deepEqual(problemsOf({ tools: { node: 22, go: "^1.22.0" } }), [
      '$.tools.node: expected a version "x.y.z", got 22',
      '$.tools.go: expected a version "x.y.z" or "x.y", got "^1.22.0"',
    ]);
    assert.deepEqual(problemsOf({ tools: { node: "01.2.3", python: "3.13.7 " } }), [
      '$.tools.node: expected a version "x.y.z", got "01.2.3"',
      '$.tools.python: expected a version "x.y.z", got "3.13.7 "',
    ]);
  });

  it("rejects skills that are not an object or not a built-in skill", () => {
    assert.deepEqual(problemsOf({ skills: "x" }), [
      "$.skills: expected an object, got a string",
    ]);
    const skill = { mode: "extend", path: "a.md" };
    assert.deepEqual(problemsOf({ skills: { plan: skill, "a-b": skill } }), [
      "$.skills.plan: unknown skill; the skills are accept, deliver, scope, shape",
      '$.skills["a-b"]: unknown skill; the skills are accept, deliver, scope, shape',
    ]);
  });

  it("accepts exactly the skill names it is given (#734)", () => {
    const skill = { mode: "extend", path: "a.md" };
    const text = JSON.stringify({ skills: { scope: skill, plan: skill } });
    assert.deepEqual(parseNibfinConfig(text, ["plan", "scope"]).skills, {
      plan: skill,
      scope: skill,
    });
    assert.throws(
      () => parseNibfinConfig(text, ["scope"]),
      /\$\.skills\.plan: unknown skill; the skills are scope/,
    );
  });

  it("rejects malformed skill entries with nested paths", () => {
    assert.deepEqual(problemsOf({ skills: { shape: null } }), [
      "$.skills.shape: expected an object, got null",
    ]);
    assert.deepEqual(
      problemsOf({
        skills: {
          shape: { mode: "replace", path: "a.md", writerBackend: "x" },
          deliver: {},
          accept: { mode: "override", path: 3 },
        },
      }),
      [
        "$.skills.accept.path: expected a string",
        '$.skills.deliver.mode: expected "extend" or "override"',
        "$.skills.deliver.path: expected a string",
        "$.skills.shape.writerBackend: unknown key",
        '$.skills.shape.mode: expected "extend" or "override"',
      ],
    );
  });

  it("lists problems from every section together", () => {
    assert.deepEqual(problemsOf({ tools: { node: "x" }, skills: [], other: 1 }), [
      "$.other: unknown key",
      '$.tools.node: expected a version "x.y.z", got "x"',
      "$.skills: expected an object, got an array",
    ]);
  });
});

describe("readNibfinConfig", () => {
  async function workspace(): Promise<string> {
    return mkdtemp(join(root, "workspace-"));
  }

  async function rejection(dir: string): Promise<ConfigError> {
    try {
      await readNibfinConfig(dir);
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error;
    }
    assert.fail("expected a ConfigError");
  }

  it("gives the defaults when the file is absent", async () => {
    assert.deepEqual(await readNibfinConfig(await workspace()), {
      tools: {},
      skills: {},
    });
  });

  it("reads and validates the workspace file", async () => {
    const dir = await workspace();
    await writeFile(join(dir, ".nibfin.json"), '{"tools":{"node":"22.15.0"}}');
    assert.deepEqual(await readNibfinConfig(dir), {
      tools: { node: "22.15.0" },
      skills: {},
    });
    await writeFile(join(dir, ".nibfin.json"), '{"writerBackend":"codex"}');
    assert.equal((await rejection(dir)).code, "CONFIG_INVALID");
  });

  it("accepts the skills of Core's own skills directory, scope included", async () => {
    const dir = await workspace();
    const skill = { mode: "extend", path: "scope.md" };
    await writeFile(
      join(dir, ".nibfin.json"),
      JSON.stringify({ skills: { scope: skill } }),
    );
    assert.deepEqual((await readNibfinConfig(dir)).skills, { scope: skill });
    const plan = JSON.stringify({ skills: { plan: skill } });
    await writeFile(join(dir, ".nibfin.json"), plan);
    const error = await rejection(dir);
    assert.equal(error.code, "CONFIG_INVALID");
    const known = "accept, deliver, repair, scope, shape";
    assert.ok(
      error.message.includes(`$.skills.plan: unknown skill; the skills are ${known}`),
      error.message,
    );
  });

  it("discovers the skill names from the given built-in directory", async () => {
    const dir = await workspace();
    const builtInDir = join(root, `built-in-${Date.now()}`);
    await mkdir(join(builtInDir, "plan"), { recursive: true });
    await writeFile(join(builtInDir, "plan", "SKILL.md"), "# Plan\n");
    const skill = { mode: "override", path: "plan.md" };
    await writeFile(
      join(dir, ".nibfin.json"),
      JSON.stringify({ skills: { plan: skill } }),
    );
    assert.deepEqual((await readNibfinConfig(dir, { builtInDir })).skills, {
      plan: skill,
    });
  });

  it("follows a symlink that stays inside the workspace", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "config"));
    await writeFile(join(dir, "config", "nibfin.json"), '{"tools":{"go":"1.20"}}');
    await symlink(join("config", "nibfin.json"), join(dir, ".nibfin.json"));
    assert.deepEqual((await readNibfinConfig(dir)).tools, { go: "1.20" });
  });

  it("reads through a workspace path that is itself a symlink", async () => {
    const dir = await workspace();
    await writeFile(join(dir, ".nibfin.json"), "{}");
    const alias = join(root, `alias-${Date.now()}`);
    await symlink(dir, alias, "dir");
    assert.deepEqual(await readNibfinConfig(alias), { tools: {}, skills: {} });
  });

  it("rejects a symlink that escapes the workspace", async () => {
    const dir = await workspace();
    const outside = join(root, `outside-${Date.now()}.json`);
    await writeFile(outside, "{}");
    await symlink(outside, join(dir, ".nibfin.json"));
    const error = await rejection(dir);
    assert.equal(error.code, "CONFIG_INVALID");
    assert.equal(error.message, ".nibfin.json resolves outside the workspace");
  });

  it("rejects a dangling symlink instead of using the defaults", async () => {
    const dir = await workspace();
    await symlink("missing.json", join(dir, ".nibfin.json"));
    const error = await rejection(dir);
    assert.equal(error.code, "CONFIG_INVALID");
    assert.equal(error.message, ".nibfin.json is a symlink to a missing file");
  });

  it("rejects a directory", async () => {
    const dir = await workspace();
    await mkdir(join(dir, ".nibfin.json"));
    const error = await rejection(dir);
    assert.equal(error.message, ".nibfin.json is not a regular file");
  });

  it("rejects a path that cannot be resolved and keeps the cause", async () => {
    const dir = await workspace();
    await symlink(".nibfin.json", join(dir, ".nibfin.json"));
    const error = await rejection(dir);
    assert.equal(error.message, ".nibfin.json cannot be resolved");
    assert.ok(error.cause instanceof Error);
  });
});
