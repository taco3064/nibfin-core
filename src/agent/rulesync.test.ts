import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createFakeCli,
  makeTempDir,
  makeWorkspace,
  parentSecrets,
  withParentEnvironment,
} from "./fake-cli.test.ts";
import { excludeFromGit, excludePattern, generateAgentConfig } from "./rulesync.ts";

let root: string;
before(async () => {
  root = await makeTempDir("rulesync-");
});
after(() => rm(root, { recursive: true, force: true }));

async function rulesyncWorkspace(): Promise<string> {
  const workspace = await makeWorkspace(root);
  await mkdir(join(workspace, ".rulesync"));
  return workspace;
}

function excludeFile(workspace: string): string {
  return join(workspace, ".git", "info", "exclude");
}

function planDocument(operations: unknown[]): string {
  const data = { plan: { version: 2, operations } };
  return `${JSON.stringify({ success: true, data }, null, 2)}\n`;
}

const writes = [
  { action: "write", kind: "file", feature: "rules", path: "CLAUDE.md" },
  { action: "write", kind: "file", feature: "mcp", path: ".mcp.json" },
  { action: "write", kind: "key", feature: "mcp", path: ".mcp.json", key: "mcpServers" },
  { action: "delete", kind: "file", feature: "skills", path: ".claude/skills/old.md" },
  { action: "write", kind: "file", feature: "skills", path: ".claude/skills/a/SKILL.md" },
  "not an operation",
  { action: "write", kind: "file", feature: "rules" },
];

const generated = ["CLAUDE.md", ".mcp.json", ".claude/skills/a/SKILL.md"];

describe("generateAgentConfig", () => {
  it("skips a workspace without .rulesync/", async () => {
    const workspace = await makeWorkspace(root);
    const fake = await createFakeCli(root, {});
    const paths = await generateAgentConfig({
      workspace,
      target: "claudecode",
      rulesync: fake.command,
    });
    assert.deepEqual(paths, []);
    assert.deepEqual(await fake.calls(), []);
  });

  it("generates the target's files and keeps them out of commits", async () => {
    const workspace = await rulesyncWorkspace();
    const files = Object.fromEntries(generated.map((path) => [path, "generated"]));
    const fake = await createFakeCli(root, { stdout: planDocument(writes), files });
    const paths = await generateAgentConfig({
      workspace,
      target: "codexcli",
      rulesync: fake.command,
    });
    assert.deepEqual(paths, generated);
    const [call] = await fake.calls();
    assert.deepEqual(call?.args, [
      "--json",
      "generate",
      "--targets",
      "codexcli",
      "--features",
      "rules,mcp,skills",
    ]);
    assert.equal(call?.cwd, workspace);
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );
    assert.equal(status, "");
  });

  it("fails with rulesync's exit code and output", async () => {
    const workspace = await rulesyncWorkspace();
    const stderr = '{"success":false,"error":{"code":"GENERATION_FAILED"}}\n';
    const fake = await createFakeCli(root, { stdout: "partial\n", stderr, exit: 2 });
    await assert.rejects(
      generateAgentConfig({ workspace, target: "claudecode", rulesync: fake.command }),
      {
        code: "AGENT_CONFIG_GENERATION_FAILED",
        message: "rulesync generate failed with exit code 2",
        exitCode: 2,
        output: `partial\n${stderr}`,
      },
    );
  });

  for (const stdout of ["not json", '{"data":{}}', '{"data":{"plan":{}}}']) {
    it(`fails when the output has no plan: ${stdout}`, async () => {
      const workspace = await rulesyncWorkspace();
      const fake = await createFakeCli(root, { stdout });
      await assert.rejects(
        generateAgentConfig({ workspace, target: "claudecode", rulesync: fake.command }),
        {
          code: "AGENT_CONFIG_GENERATION_FAILED",
          message: "rulesync generate printed no file plan",
          exitCode: 0,
          output: stdout,
        },
      );
    });
  }

  it("keeps GitHub tokens out of the rulesync environment", async () => {
    const restore = withParentEnvironment({ ...parentSecrets, LANG: "C.UTF-8" });
    try {
      const workspace = await rulesyncWorkspace();
      const fake = await createFakeCli(root, { stdout: planDocument([]) });
      await generateAgentConfig({
        workspace,
        target: "claudecode",
        rulesync: fake.command,
      });
      const [env] = await fake.environments();
      assert.equal(env?.GITHUB_TOKEN, undefined);
      assert.equal(env?.GH_TOKEN, undefined);
      assert.equal(env?.LANG, "C.UTF-8");
    } finally {
      restore();
    }
  });
});

describe("excludeFromGit", () => {
  it("appends anchored, escaped patterns once", async () => {
    const workspace = await makeWorkspace(root);
    const file = excludeFile(workspace);
    const original = await readFile(file, "utf8");
    await excludeFromGit(workspace, ["a.md", "dir/b c.md"]);
    await excludeFromGit(workspace, ["a.md", "dir/b c.md"]);
    assert.equal(await readFile(file, "utf8"), `${original}/a.md\n/dir/b\\ c.md\n`);
  });

  it("creates the exclude file when it is missing", async () => {
    const workspace = await makeWorkspace(root);
    await rm(join(workspace, ".git", "info"), { recursive: true, force: true });
    await excludeFromGit(workspace, ["a.md"]);
    assert.equal(await readFile(excludeFile(workspace), "utf8"), "/a.md\n");
  });

  it("starts a new line after a file without a trailing newline", async () => {
    const workspace = await makeWorkspace(root);
    await writeFile(excludeFile(workspace), "# local");
    await excludeFromGit(workspace, ["a.md"]);
    assert.equal(await readFile(excludeFile(workspace), "utf8"), "# local\n/a.md\n");
  });

  it("leaves the file alone when nothing was generated", async () => {
    const workspace = await makeWorkspace(root);
    await writeFile(excludeFile(workspace), "# local");
    await excludeFromGit(workspace, []);
    assert.equal(await readFile(excludeFile(workspace), "utf8"), "# local");
  });
});

describe("excludePattern", () => {
  it("escapes gitignore wildcards, backslashes and spaces", () => {
    assert.equal(excludePattern("a*b?[c]\\d e"), "/a\\*b\\?\\[c\\]\\\\d\\ e");
  });
});
