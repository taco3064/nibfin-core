import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeTempDir } from "./fake-cli.test.ts";
import { loginCommand, providers, providerSpecs } from "./provider.ts";

let root: string;
before(async () => {
  root = await makeTempDir("provider-");
});
after(() => rm(root, { recursive: true, force: true }));

describe("providerSpecs", () => {
  it("covers every provider", () => {
    assert.deepEqual(Object.keys(providerSpecs).toSorted(), [...providers].toSorted());
  });

  it("describes Claude Code", () => {
    const spec = providerSpecs.claude;
    assert.equal(spec.executable, "claude");
    assert.equal(spec.configHomeVariable, "CLAUDE_CONFIG_DIR");
    assert.equal(spec.rulesyncTarget, "claudecode");
    assert.equal(spec.defaultModel, "opus");
    assert.deepEqual(spec.loginStatusArgs, ["auth", "status"]);
    assert.deepEqual(spec.headlessArgs("opus", "/unused"), [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus",
    ]);
  });

  it("describes Codex", () => {
    const spec = providerSpecs.codex;
    assert.equal(spec.executable, "codex");
    assert.equal(spec.configHomeVariable, "CODEX_HOME");
    assert.equal(spec.rulesyncTarget, "codexcli");
    assert.equal(spec.defaultModel, undefined);
    assert.deepEqual(spec.loginStatusArgs, ["login", "status"]);
    const fixed = [
      "exec",
      "--json",
      "--trust",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    assert.deepEqual(spec.headlessArgs(undefined, "/last"), [
      ...fixed,
      "-o",
      "/last",
      "-",
    ]);
    assert.deepEqual(spec.headlessArgs("gpt-5", "/last"), [
      ...fixed,
      "-o",
      "/last",
      "-m",
      "gpt-5",
      "-",
    ]);
  });

  it("leaves the Codex home alone; Codex saves trust itself", async () => {
    const home = join(root, "codex-home");
    await providerSpecs.codex.prepareHome(home);
    await assert.rejects(stat(home), { code: "ENOENT" });
  });
});

describe("loginCommand", () => {
  it("names the provider in the re-login command", () => {
    assert.equal(loginCommand("claude"), "gh nibfin login --provider claude");
    assert.equal(loginCommand("codex"), "gh nibfin login --provider codex");
  });
});
