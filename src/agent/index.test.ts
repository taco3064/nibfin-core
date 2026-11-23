import assert from "node:assert/strict";
import { test } from "node:test";
import * as agent from "./index.ts";

test("the agent module exports its public API", () => {
  assert.deepEqual(Object.keys(agent).toSorted(), [
    "AgentError",
    "defaultExecutables",
    "enableProjectMcpServers",
    "excludeFromGit",
    "generateAgentConfig",
    "loginCommand",
    "projectMcpSetting",
    "providerSpecs",
    "providers",
    "runAgent",
  ]);
  assert.deepEqual(agent.defaultExecutables, {
    claude: { command: "claude", args: [] },
    codex: { command: "codex", args: [] },
    rulesync: { command: "rulesync", args: [] },
  });
});
