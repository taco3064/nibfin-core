import assert from "node:assert/strict";
import { test } from "node:test";
import * as config from "./index.ts";

test("the config module exports its public API", () => {
  assert.deepEqual(Object.keys(config).toSorted(), [
    "ConfigError",
    "configFileName",
    "defaultBuiltInDir",
    "defaultToolExecutables",
    "parseNibfinConfig",
    "prepareTools",
    "readNibfinConfig",
    "resolveRoleSkill",
    "roleNames",
    "toolNames",
  ]);
  assert.equal(config.configFileName, ".nibfin.json");
  assert.deepEqual(config.toolNames, ["node", "python", "go"]);
  assert.deepEqual(config.roleNames, ["shape", "deliver", "accept"]);
  assert.deepEqual(config.defaultToolExecutables, {
    tar: { command: "tar", args: [] },
    uv: { command: "uv", args: [] },
  });
});

test("ConfigError keeps its code and cause", () => {
  const cause = new Error("inner");
  const error = new config.ConfigError("CONFIG_INVALID", "msg", cause);
  assert.equal(error.name, "ConfigError");
  assert.equal(error.code, "CONFIG_INVALID");
  assert.equal(error.message, "msg");
  assert.equal(error.cause, cause);
  assert.ok(error instanceof Error);
});
