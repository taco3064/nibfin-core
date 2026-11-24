import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fakeToken } from "../github/fake-github.test.ts";
import { parseJobOptions, readJobContext } from "./context.ts";
import { StageError } from "./errors.ts";

const workspace = resolve("/jobs/workspace");
const env = {
  NIBFIN_GITHUB_TOKEN: fakeToken,
  NIBFIN_AGENT_HOME: resolve("/login/claude"),
  NIBFIN_WORKSPACE: workspace,
  NIBFIN_TOOL_CACHE: resolve("/cache"),
};
const args = ["--stage", "shape", "--repo", "acme/app.js", "--issue", "7"];
const withProvider = [...args, "--provider", "codex"];

function inputError(run: () => unknown, message: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_INPUT_INVALID");
    assert.equal(error.message, message);
    assert.ok(!error.message.includes(fakeToken));
    return true;
  });
}

describe("readJobContext", () => {
  it("reads the options and the environment", () => {
    assert.deepEqual(readJobContext(withProvider, env), {
      repo: { owner: "acme", repo: "app.js" },
      issue: 7,
      provider: "codex",
      token: fakeToken,
      agentHome: env.NIBFIN_AGENT_HOME,
      workspace,
      toolCache: env.NIBFIN_TOOL_CACHE,
    });
  });

  it("ignores NIBFIN_ACTOR_* and reads the memory requirement", () => {
    const withActor = { ...env, NIBFIN_ACTOR_ID: "x", NIBFIN_MEMORY_REQUIRED: "3g" };
    const context = readJobContext(withProvider, withActor);
    assert.equal(context.memoryRequired, 3 * 1024 ** 3);
    assert.equal("actor" in context, false);
  });

  it("takes an optional model", () => {
    const context = readJobContext([...withProvider, "--model", "sonnet"], env);
    assert.equal(context.model, "sonnet");
  });

  const deliver = ["--stage", "deliver", "--repo", "a/b", "--issue", "1"];
  const deliverArgs = [...deliver, "--provider", "claude"];
  const runEnv = {
    ...env,
    NIBFIN_RUN_REPO: "acme/runner",
    NIBFIN_RUN_ID: "77",
    NIBFIN_NEXT_FILE: resolve("/jobs/next.json"),
  };

  it("reads the Deliver reason, the execution run and the next-action file", () => {
    const context = readJobContext([...deliverArgs, "--reason", "review"], runEnv);
    assert.equal(context.reason, "review");
    assert.deepEqual(context.runRepo, { owner: "acme", repo: "runner" });
    assert.equal(context.runId, 77);
    assert.equal(context.nextFile, runEnv.NIBFIN_NEXT_FILE);
    const plain = readJobContext(deliverArgs, env);
    for (const field of ["reason", "runRepo", "runId", "nextFile"]) {
      assert.ok(!Object.hasOwn(plain, field), field);
    }
  });

  for (const [name, options, change, message] of [
    [
      "a reason for another stage",
      [...withProvider, "--reason", "review"],
      {},
      "--reason is only valid with --stage deliver",
    ],
    [
      "an unknown reason",
      [...deliverArgs, "--reason", "flaky"],
      {},
      "--reason must be one of ci-failure, review, cd-failure",
    ],
    [
      "a bad run repo",
      deliverArgs,
      { NIBFIN_RUN_REPO: "x" },
      "NIBFIN_RUN_REPO must be " + "<owner>/<repo>",
    ],
    [
      "a bad run id",
      deliverArgs,
      { NIBFIN_RUN_ID: "1.5" },
      "NIBFIN_RUN_ID must be a positive integer",
    ],
    [
      "a relative next file",
      deliverArgs,
      { NIBFIN_NEXT_FILE: "next.json" },
      "NIBFIN_NEXT_FILE must be an absolute path",
    ],
    [
      "a next file in the workspace",
      deliverArgs,
      { NIBFIN_NEXT_FILE: join(workspace, "next.json") },
      "NIBFIN_NEXT_FILE must be outside NIBFIN_WORKSPACE",
    ],
    [
      "the workspace as next file",
      deliverArgs,
      { NIBFIN_NEXT_FILE: workspace },
      "NIBFIN_NEXT_FILE must be outside NIBFIN_WORKSPACE",
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      inputError(() => readJobContext(options, { ...env, ...change }), message);
    });
  }

  for (const [name, options, message] of [
    ["a missing repo", ["--issue", "1", "--provider", "claude"], "--repo is missing"],
    ["a bad repo", ["--repo", "acme", "--issue", "1"], "--repo must be <owner>/<repo>"],
    ["a missing issue", ["--repo", "a/b"], "--issue is missing"],
    [
      "a zero issue",
      ["--repo", "a/b", "--issue", "0"],
      "--issue must be a positive integer",
    ],
    [
      "an unsafe issue",
      ["--repo", "a/b", "--issue", "99999999999999999"],
      "--issue must be a positive integer",
    ],
    ["a missing provider", ["--repo", "a/b", "--issue", "1"], "--provider is missing"],
    [
      "an unknown provider",
      ["--repo", "a/b", "--issue", "1", "--provider", "gpt"],
      "--provider must be one of codex, claude",
    ],
    [
      "a blank model",
      ["--repo", "a/b", "--issue", "1", "--provider", "claude", "--model", " "],
      "--model is missing",
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      inputError(() => readJobContext(options, env), message);
    });
  }

  for (const [name, change, message] of [
    [
      "a missing token",
      { NIBFIN_GITHUB_TOKEN: undefined },
      "NIBFIN_GITHUB_TOKEN is missing",
    ],
    ["a blank token", { NIBFIN_GITHUB_TOKEN: " " }, "NIBFIN_GITHUB_TOKEN is missing"],
    [
      "a memory requirement without a unit we know",
      { NIBFIN_MEMORY_REQUIRED: "3x" },
      "NIBFIN_MEMORY_REQUIRED must be a number with b, k, m or g",
    ],
    [
      "a relative agent home",
      { NIBFIN_AGENT_HOME: "home" },
      "NIBFIN_AGENT_HOME must be an absolute path",
    ],
    [
      "a missing workspace",
      { NIBFIN_WORKSPACE: undefined },
      "NIBFIN_WORKSPACE is missing",
    ],
    [
      "a relative tool cache",
      { NIBFIN_TOOL_CACHE: "cache" },
      "NIBFIN_TOOL_CACHE must be an absolute path",
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      inputError(() => readJobContext(withProvider, { ...env, ...change }), message);
    });
  }
});

describe("parseJobOptions", () => {
  it("reads each known option once", () => {
    assert.deepEqual(parseJobOptions(["--stage", "shape", "--model", "x"]), {
      stage: "shape",
      model: "x",
    });
  });

  for (const [name, options, message] of [
    ["an unknown option", ["--force", "1"], '"--force" is not a known option'],
    ["a bare value", ["shape"], '"shape" is not a known option'],
    ["a missing value", ["--issue"], "--issue needs a value"],
    ["an option as value", ["--issue", "--repo"], "--issue needs a value"],
    [
      "a repeated option",
      ["--issue", "1", "--issue", "2"],
      "--issue is given more than once",
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      inputError(() => parseJobOptions(options), message);
    });
  }
});
