import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "./errors.ts";
import { makeJobDirs, makeTempDir, writeTree } from "./fixtures.test.ts";
import type { NibfinConfig, RoleName, SkillMode } from "./schema.ts";
import { defaultBuiltInDir, resolveRoleSkill } from "./skills.ts";

let root: string;
let workspace: string;
let builtInDir: string;
let outsideFile: string;

before(async () => {
  root = await makeTempDir("config-skills-");
  ({ workspace } = await makeJobDirs(root));
  builtInDir = join(root, "built-in");
  outsideFile = join(root, "outside.md");
  await writeTree(builtInDir, {
    "deliver/SKILL.md": "# Deliver\n\nBuilt-in text.\n\n",
    "accept/SKILL.md": "# Accept\n",
  });
  await writeTree(workspace, {
    "docs/deliver.md": "Repository text.\n",
    "notes.txt": "not markdown",
    "folder.md/inner.md": "nested",
  });
  await writeFile(outsideFile, "outside");
  await writeFile(join(workspace, "binary.md"), Buffer.from([0xff, 0xfe, 0x00]));
  await symlink(outsideFile, join(workspace, "escape.md"));
  await symlink("gone.md", join(workspace, "dangling.md"));
  await symlink("notes.txt", join(workspace, "alias.md"));
  await symlink(join("docs", "deliver.md"), join(workspace, "inside.md"));
  await symlink("loop.md", join(workspace, "loop.md"));
});
after(() => rm(root, { recursive: true, force: true }));

function configFor(role: RoleName, mode: SkillMode, path: string): NibfinConfig {
  return { tools: {}, skills: { [role]: { mode, path } } };
}

function resolveDeliver(mode: SkillMode, path: string): Promise<string> {
  return resolveRoleSkill("deliver", configFor("deliver", mode, path), {
    workspace,
    builtInDir,
  });
}

async function rejection(mode: SkillMode, path: string): Promise<ConfigError> {
  try {
    await resolveDeliver(mode, path);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.code, "CONFIG_SKILL_PATH_INVALID");
    return error;
  }
  assert.fail(`expected ${path} to be rejected`);
}

describe("resolveRoleSkill", () => {
  it("uses the built-in skill when the role has no setting", async () => {
    const config: NibfinConfig = { tools: {}, skills: {} };
    const text = await resolveRoleSkill("accept", config, { workspace, builtInDir });
    assert.equal(text, "# Accept\n");
  });

  it("reads Core's own skills directory by default", async () => {
    const config: NibfinConfig = { tools: {}, skills: {} };
    const expected = await readFile(join(defaultBuiltInDir, "shape", "SKILL.md"), "utf8");
    assert.equal(await resolveRoleSkill("shape", config, { workspace }), expected);
    assert.ok(expected.length > 0);
  });

  it("appends the repository file for extend", async () => {
    assert.equal(
      await resolveDeliver("extend", "docs/deliver.md"),
      "# Deliver\n\nBuilt-in text.\n\nRepository text.\n",
    );
  });

  it("uses only the repository file for override", async () => {
    assert.equal(
      await resolveDeliver("override", "docs/deliver.md"),
      "Repository text.\n",
    );
  });

  it("follows a symlink that stays inside the workspace", async () => {
    assert.equal(await resolveDeliver("override", "inside.md"), "Repository text.\n");
  });

  it("never uses the built-in text when an override file is missing", async () => {
    const error = await rejection("override", "missing.md");
    assert.equal(error.message, '$.skills.deliver.path "missing.md" does not exist');
  });

  it("rejects unsafe or unusable paths with the path and reason", async () => {
    const cases: [string, string][] = [
      ["/etc/skill.md", "must be relative to the workspace"],
      ["C:\\skill.md", "must be relative to the workspace"],
      ["\\\\server\\share\\skill.md", "must be relative to the workspace"],
      ["skill\0.md", "contains a NUL character"],
      ["notes.txt", "must name a .md file"],
      ["", "must name a .md file"],
      ["../outside.md", "points outside the workspace"],
      ["escape.md", "resolves outside the workspace"],
      ["dangling.md", "is a symlink to a missing file"],
      ["folder.md", "is not a regular file"],
      ["alias.md", "resolves to a file that is not .md"],
      ["binary.md", "is not UTF-8 text"],
      ["loop.md", "cannot be resolved"],
    ];
    for (const [path, reason] of cases) {
      for (const mode of ["extend", "override"] as const) {
        const error = await rejection(mode, path);
        const expected = `$.skills.deliver.path ${JSON.stringify(path)} ${reason}`;
        assert.equal(error.message, expected);
      }
    }
  });

  it("keeps the original cause of a decoding failure", async () => {
    const error = await rejection("extend", "binary.md");
    assert.ok(error.cause instanceof TypeError);
  });
});
