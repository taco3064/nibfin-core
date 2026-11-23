import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { enableProjectMcpServers, projectMcpSetting } from "./claude-settings.ts";
import { makeTempDir } from "./fake-cli.test.ts";

let root: string;
before(async () => {
  root = await makeTempDir("settings-");
});
after(() => rm(root, { recursive: true, force: true }));

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("enableProjectMcpServers", () => {
  it("creates the home and settings file when absent", async () => {
    const home = join(root, "fresh", "home");
    await enableProjectMcpServers(home);
    assert.deepEqual(await readJson(join(home, "settings.json")), {
      [projectMcpSetting]: true,
    });
    assert.deepEqual(await readdir(home), ["settings.json"]);
  });

  it("keeps the other keys of existing settings", async () => {
    const home = join(root, "existing");
    await mkdir(home);
    const file = join(home, "settings.json");
    const settings = { model: "opus", [projectMcpSetting]: false, env: { A: "1" } };
    await writeFile(file, JSON.stringify(settings));
    await enableProjectMcpServers(home);
    assert.deepEqual(await readJson(file), { ...settings, [projectMcpSetting]: true });
  });

  it("does not rewrite settings that already enable the servers", async () => {
    const home = join(root, "repeated");
    await enableProjectMcpServers(home);
    const file = join(home, "settings.json");
    const before = await stat(file);
    const text = await readFile(file, "utf8");
    await enableProjectMcpServers(home);
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  });

  // Jobs run in Linux containers, where rename(2) replaces the file atomically;
  // Windows refuses to replace a file another rename is still moving.
  const linuxOnly = process.platform === "win32" && "rename replacement is POSIX-only";
  it("leaves valid settings after concurrent merges", { skip: linuxOnly }, async () => {
    const home = join(root, "concurrent");
    await mkdir(home);
    const file = join(home, "settings.json");
    await writeFile(file, JSON.stringify({ theme: "dark" }));
    await Promise.all(Array.from({ length: 5 }, () => enableProjectMcpServers(home)));
    assert.deepEqual(await readJson(file), { theme: "dark", [projectMcpSetting]: true });
    assert.deepEqual(await readdir(home), ["settings.json"]);
  });

  for (const [label, text, reason] of [
    ["invalid JSON", "{", "is not valid JSON"],
    ["a non-object", "[]", "is not a JSON object"],
  ]) {
    it(`refuses to overwrite settings that hold ${label}`, async () => {
      const home = await makeTempDir("settings-bad-");
      const file = join(home, "settings.json");
      await writeFile(file, text);
      try {
        await assert.rejects(enableProjectMcpServers(home), {
          code: "AGENT_CONFIG_INVALID",
          message: `${file} ${reason}`,
        });
        assert.equal(await readFile(file, "utf8"), text);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
