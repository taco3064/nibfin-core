import assert from "node:assert/strict";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  captureSink,
  createFakeCli,
  jsonLines,
  makeTempDir,
  makeWorkspace,
  parentSecrets,
  withParentEnvironment,
} from "./fake-cli.test.ts";
import { resolveCommand } from "./resolve-command.ts";
import { runAgent } from "./run.ts";

let root: string;
before(async () => {
  root = await makeTempDir("path-");
});
after(() => rm(root, { recursive: true, force: true }));

async function executable(dir: string, name: string, text: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, text);
  await chmod(file, 0o755);
  return realpath(file);
}

/** The parent `PATH` as the allowlist sees it (Windows names it `Path`). */
function parentPath(): string | undefined {
  return Object.entries(process.env).find(([name]) => name === "PATH")?.[1];
}

describe("resolveCommand", () => {
  it("runs a node script found on PATH through Core's Node", async () => {
    const bin = join(root, "bin-a");
    const file = await executable(bin, "agent-cli", "#!/usr/bin/env node\n");
    const path = [join(root, "missing"), "", bin].join(delimiter);
    const command = { command: "agent-cli", args: ["--flag"] };
    assert.deepEqual(await resolveCommand(command, root, path), {
      command: process.execPath,
      args: [file, "--flag"],
    });
  });

  it("runs a .js file through Core's Node", async () => {
    const file = await executable(join(root, "bin-b"), "cli.js", "console.log(1);\n");
    assert.deepEqual(await resolveCommand({ command: file, args: [] }, root, ""), {
      command: process.execPath,
      args: [file],
    });
  });

  it("runs another executable by its absolute path", async () => {
    const file = await executable(join(root, "bin-c"), "native", "\x7fELF binary");
    const command = { command: "./bin-c/native", args: ["x"] };
    assert.deepEqual(await resolveCommand(command, root, undefined), {
      command: file,
      args: ["x"],
    });
  });

  it("skips a directory with the command's name", async () => {
    await mkdir(join(root, "bin-d", "agent-cli"), { recursive: true });
    const later = await executable(join(root, "bin-e"), "agent-cli", "#!/bin/sh\n");
    const path = [join(root, "bin-d"), join(root, "bin-e")].join(delimiter);
    const command = { command: "agent-cli", args: [] };
    assert.deepEqual(await resolveCommand(command, root, path), {
      command: later,
      args: [],
    });
  });

  it("fails when no executable is found", async () => {
    await assert.rejects(
      resolveCommand({ command: "no-such-agent", args: [] }, root, undefined),
      {
        code: "AGENT_RUN_FAILED",
        message: "no-such-agent is not an executable on PATH",
      },
    );
  });
});

describe("runAgent pathEntries", () => {
  let restore: () => void;
  before(() => {
    restore = withParentEnvironment({
      ...parentSecrets,
      NIBFIN_GITHUB_TOKEN: "fake-nibfin-token",
    });
  });
  after(() => restore());

  const success = jsonLines({ type: "result", result: "done" });

  async function setup(exit = 0) {
    const workspace = await makeWorkspace(root);
    const home = join(root, `home-${Math.random()}`);
    const fake = await createFakeCli(root, {
      homeVariable: "CLAUDE_CONFIG_DIR",
      stdout: success,
      exit,
      statusExit: 0,
    });
    return { workspace, home, fake };
  }

  it("prepends the entries for the agent CLI only", async () => {
    const t = await setup(3);
    const entries = [join(root, "tools", "node"), join(root, "tools", "go")];
    await assert.rejects(
      runAgent({
        provider: "claude",
        workspace: t.workspace,
        home: t.home,
        prompt: "x",
        pathEntries: entries,
        executables: { claude: t.fake.command },
        output: { stdout: captureSink(), stderr: captureSink() },
      }),
      { code: "AGENT_RUN_FAILED", exitCode: 3 },
    );
    const [agentEnv, statusEnv] = await t.fake.environments();
    const inherited = parentPath();
    const expected = [...entries, ...(inherited === undefined ? [] : [inherited])];
    assert.equal(agentEnv?.PATH, expected.join(delimiter));
    assert.equal(statusEnv?.PATH, inherited);
    for (const env of [agentEnv, statusEnv]) {
      assert.equal(env?.NIBFIN_GITHUB_TOKEN, undefined);
      assert.equal(env?.GITHUB_TOKEN, undefined);
    }
  });

  it("starts a script CLI through Core's Node by absolute path", async () => {
    const t = await setup();
    const [script] = t.fake.command.args;
    await chmod(script, 0o755);
    const result = await runAgent({
      provider: "claude",
      workspace: t.workspace,
      home: t.home,
      prompt: "x",
      pathEntries: [join(root, "tools", "python")],
      executables: { claude: { command: script, args: [] } },
      output: { stdout: captureSink(), stderr: captureSink() },
    });
    assert.deepEqual(result, { exitCode: 0, finalMessage: "done" });
    assert.equal((await t.fake.calls()).length, 1);
  });

  it("keeps the inherited PATH without entries", async () => {
    const t = await setup();
    await runAgent({
      provider: "claude",
      workspace: t.workspace,
      home: t.home,
      prompt: "x",
      pathEntries: [],
      executables: { claude: t.fake.command },
      output: { stdout: captureSink(), stderr: captureSink() },
    });
    const [env] = await t.fake.environments();
    assert.equal(env?.PATH, parentPath());
  });
});
