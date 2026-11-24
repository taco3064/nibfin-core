import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  captureSink,
  createFakeCli,
  type FakeScenario,
  jsonLines,
  makeTempDir,
  makeWorkspace,
  parentSecrets,
  withParentEnvironment,
} from "./fake-cli.test.ts";
import type { Provider } from "./provider.ts";
import { runAgent } from "./run.ts";

let root: string;
before(async () => {
  root = await makeTempDir("run-");
});
after(() => rm(root, { recursive: true, force: true }));

const homeVariables = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

async function setup(provider: Provider, scenario: FakeScenario, model?: string) {
  const workspace = await makeWorkspace(root);
  const home = join(workspace, "..", `${provider}-home-${Date.now()}-${Math.random()}`);
  const fake = await createFakeCli(root, {
    homeVariable: homeVariables[provider],
    ...scenario,
  });
  const stdout = captureSink();
  const stderr = captureSink();
  const run = () =>
    runAgent({
      provider,
      workspace,
      home,
      prompt: "Do the work.\nSecond line.",
      ...(model === undefined ? {} : { model }),
      executables: { [provider]: fake.command },
      output: { stdout, stderr },
    });
  return { workspace, home, fake, stdout, stderr, run };
}

const lastMessageFile = (workspace: string) =>
  join(workspace, ".git", "nibfin-last-message");

const claudeSuccess = jsonLines(
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [] } },
  { type: "result", subtype: "success", is_error: false, result: "All done." },
);

describe("runAgent with Claude Code", () => {
  it("runs headless in the workspace and returns the result message", async () => {
    const stdout = `plain text line\n${claudeSuccess}`;
    const t = await setup("claude", { stdout, stderr: "warning\n" });
    assert.deepEqual(await t.run(), { exitCode: 0, finalMessage: "All done." });
    assert.deepEqual(await t.fake.calls(), [
      {
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
          "--model",
          "opus",
        ],
        cwd: t.workspace,
        home: t.home,
        stdin: "Do the work.\nSecond line.",
      },
    ]);
    assert.equal(t.stdout.text(), stdout);
    assert.equal(t.stderr.text(), "warning\n");
    const settings: unknown = JSON.parse(
      await readFile(join(t.home, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings, { enableAllProjectMcpServers: true });
    await assert.rejects(stat(lastMessageFile(t.workspace)), { code: "ENOENT" });
  });

  it("passes a requested model", async () => {
    const t = await setup("claude", { stdout: claudeSuccess }, "sonnet");
    await t.run();
    const [call] = await t.fake.calls();
    assert.deepEqual(call?.args.slice(-2), ["--model", "sonnet"]);
  });

  it("keeps the exit code of a failure that is not a login problem", async () => {
    const t = await setup("claude", { stdout: "boom\n", exit: 3 });
    await assert.rejects(t.run(), {
      code: "AGENT_RUN_FAILED",
      exitCode: 3,
      message: "Claude Code failed with exit code 3; its output is in the log above",
    });
    const calls = await t.fake.calls();
    assert.deepEqual(calls[1], {
      args: ["auth", "status"],
      cwd: t.workspace,
      home: t.home,
      stdin: "",
    });
    assert.equal(t.stdout.text(), "boom\n");
  });

  for (const event of [
    { type: "assistant", error: "authentication_failed", message: {} },
    { type: "system", subtype: "api_retry", error: "authentication_failed" },
  ]) {
    it(`asks for a new login after a ${event.type} authentication_failed`, async () => {
      const t = await setup("claude", { stdout: jsonLines(event), exit: 1 });
      await assert.rejects(t.run(), {
        code: "AGENT_LOGIN_REQUIRED",
        exitCode: 1,
        loginCommand: "gh nibfin login --provider claude",
        message:
          "Claude Code login is missing or expired (exit code 1). " +
          "Run: gh nibfin login --provider claude",
      });
      assert.equal((await t.fake.calls()).length, 1);
    });
  }

  it("asks for a new login when auth status reports no login", async () => {
    const t = await setup("claude", { exit: 1, statusExit: 1 });
    await assert.rejects(t.run(), { code: "AGENT_LOGIN_REQUIRED", exitCode: 1 });
  });

  it("fails when a successful run has no result message", async () => {
    const t = await setup("claude", { stdout: jsonLines({ type: "system" }) });
    await assert.rejects(t.run(), {
      code: "AGENT_RUN_FAILED",
      exitCode: 0,
      message: "Claude Code exited 0 without a final message",
    });
  });

  it("reports a CLI that cannot start with its original error", async () => {
    const workspace = await makeWorkspace(root);
    await assert.rejects(
      runAgent({
        provider: "claude",
        workspace,
        home: join(workspace, "..", "missing-cli-home"),
        prompt: "x",
        executables: { claude: { command: join(root, "no-such-cli"), args: [] } },
        output: { stdout: captureSink(), stderr: captureSink() },
      }),
      { code: "ENOENT" },
    );
  });
});

describe("runAgent with Codex", () => {
  const events = jsonLines({ type: "thread.started" }, { type: "turn.completed" });

  it("runs exec headless and returns the last message file", async () => {
    const t = await setup("codex", { stdout: events, lastMessage: "Codex done." });
    assert.deepEqual(await t.run(), { exitCode: 0, finalMessage: "Codex done." });
    const file = lastMessageFile(t.workspace);
    assert.deepEqual(await t.fake.calls(), [
      {
        args: [
          "exec",
          "--json",
          "--trust",
          "--dangerously-bypass-approvals-and-sandbox",
          "-c",
          "features.memories=false",
          "-o",
          file,
          "-",
        ],
        cwd: t.workspace,
        home: t.home,
        stdin: "Do the work.\nSecond line.",
      },
    ]);
    assert.equal(t.stdout.text(), events);
    await assert.rejects(stat(file), { code: "ENOENT" });
    await assert.rejects(stat(t.home), { code: "ENOENT" });
  });

  it("passes a requested model", async () => {
    const t = await setup("codex", { lastMessage: "ok" }, "gpt-5");
    await t.run();
    const [call] = await t.fake.calls();
    assert.deepEqual(call?.args.slice(-3), ["-m", "gpt-5", "-"]);
  });

  it("asks for a new login after an auth-refresh turn failure", async () => {
    const message =
      "Your access token could not be refreshed. Please log out and sign in again.";
    const stdout = jsonLines({ type: "turn.failed", error: { message } });
    const t = await setup("codex", { stdout, exit: 1 });
    await assert.rejects(t.run(), {
      code: "AGENT_LOGIN_REQUIRED",
      exitCode: 1,
      loginCommand: "gh nibfin login --provider codex",
    });
  });

  it("asks for a new login when login status reports no login", async () => {
    const t = await setup("codex", { exit: 1, statusExit: 1 });
    await assert.rejects(t.run(), { code: "AGENT_LOGIN_REQUIRED" });
    const calls = await t.fake.calls();
    assert.deepEqual(calls[1]?.args, ["login", "status"]);
    assert.equal(calls[1]?.home, t.home);
  });

  it("keeps the exit code of other failures", async () => {
    const t = await setup("codex", { exit: 2 });
    await assert.rejects(t.run(), {
      code: "AGENT_RUN_FAILED",
      exitCode: 2,
      message: "Codex failed with exit code 2; its output is in the log above",
    });
  });

  it("never returns a stale last message", async () => {
    const t = await setup("codex", {});
    await writeFile(lastMessageFile(t.workspace), "stale");
    await assert.rejects(t.run(), {
      code: "AGENT_RUN_FAILED",
      exitCode: 0,
      message: "Codex exited 0 without a final message",
    });
  });
});

describe("runAgent agent config", () => {
  it("generates rulesync files for the provider before the run", async () => {
    const t = await setup("codex", { lastMessage: "ok" });
    await mkdir(join(t.workspace, ".rulesync"));
    const plan = { operations: [{ action: "write", kind: "file", path: "AGENTS.md" }] };
    const rulesync = await createFakeCli(root, {
      stdout: JSON.stringify({ success: true, data: { plan } }),
      files: { "AGENTS.md": "rules" },
    });
    const seenBeforeStart: string[][] = [];
    await runAgent({
      provider: "codex",
      workspace: t.workspace,
      home: t.home,
      prompt: "x",
      executables: { codex: t.fake.command, rulesync: rulesync.command },
      output: { stdout: captureSink(), stderr: captureSink() },
      beforeStart: async () => {
        const calls = await t.fake.calls();
        seenBeforeStart.push([...(await readdir(t.workspace)), `${calls.length} calls`]);
      },
    });
    // The hook runs after rulesync generated AGENTS.md and before the CLI starts.
    assert.deepEqual(
      seenBeforeStart.map((seen) => seen.toSorted()),
      [[".git", ".rulesync", "0 calls", "AGENTS.md"]],
    );
    const [call] = await rulesync.calls();
    assert.deepEqual(call?.args.slice(0, 4), [
      "--json",
      "generate",
      "--targets",
      "codexcli",
    ]);
    const exclude = await readFile(join(t.workspace, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/AGENTS\.md$/m);
    assert.deepEqual((await readdir(t.workspace)).toSorted(), [
      ".git",
      ".rulesync",
      "AGENTS.md",
    ]);
  });
});

describe("runAgent child environment", () => {
  const inherited = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HTTPS_PROXY: "http://proxy:8" };
  let restore: () => void;
  before(() => {
    restore = withParentEnvironment({
      ...parentSecrets,
      ...inherited,
      NIBFIN_UNLISTED: "unlisted",
    });
  });
  after(() => restore());

  function assertAllowlisted(env: Record<string, string>, homeVariable: string) {
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.NIBFIN_UNLISTED, undefined);
    for (const [name, value] of Object.entries(inherited)) {
      assert.equal(env[name], value);
    }
    assert.ok(env[homeVariable]);
  }

  it("keeps GitHub tokens from the Claude run and auth status", async () => {
    const t = await setup("claude", { exit: 3 });
    await assert.rejects(t.run(), { code: "AGENT_RUN_FAILED" });
    const environments = await t.fake.environments();
    assert.equal(environments.length, 2);
    for (const env of environments) {
      assertAllowlisted(env, "CLAUDE_CONFIG_DIR");
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    }
  });

  it("keeps GitHub tokens from the Codex run and login status", async () => {
    const t = await setup("codex", { exit: 1, statusExit: 1 });
    await assert.rejects(t.run(), { code: "AGENT_LOGIN_REQUIRED" });
    const environments = await t.fake.environments();
    assert.equal(environments.length, 2);
    for (const env of environments) {
      assertAllowlisted(env, "CODEX_HOME");
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
    }
  });
});
