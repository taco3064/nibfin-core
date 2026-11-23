import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fakeToken } from "../github/fake-github.test.ts";
import { parseJobOptions, readJobContext } from "./context.ts";
import { StageError } from "./errors.ts";

const workspace = resolve("/jobs/workspace");
const env = {
  NIBFIN_GITHUB_TOKEN: fakeToken,
  NIBFIN_ACTOR_ID: "42",
  NIBFIN_ACTOR_LOGIN: "nibfin-bot",
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
      actor: { id: 42, login: "nibfin-bot" },
      agentHome: env.NIBFIN_AGENT_HOME,
      workspace,
      toolCache: env.NIBFIN_TOOL_CACHE,
    });
  });

  it("takes an optional model", () => {
    const context = readJobContext([...withProvider, "--model", "sonnet"], env);
    assert.equal(context.model, "sonnet");
  });

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
      "an actor id that is not a number",
      { NIBFIN_ACTOR_ID: "bot" },
      "NIBFIN_ACTOR_ID must be a positive integer",
    ],
    ["a missing login", { NIBFIN_ACTOR_LOGIN: "" }, "NIBFIN_ACTOR_LOGIN is missing"],
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
