import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./errors.ts";
import { resolveWorkspaceFile } from "./paths.ts";
import type { NibfinConfig, RoleName } from "./schema.ts";

/** Core's own `skills/` directory, shipped beside `src/` and `dist/`. */
export const defaultBuiltInDir = fileURLToPath(new URL("../../skills/", import.meta.url));

export interface ResolveRoleSkillOptions {
  workspace: string;
  /** Holds `<role>/SKILL.md`; Core's own `skills/` by default. */
  builtInDir?: string;
}

/**
 * The built-in skills (Proposal R7.5): the sorted names of the directories of
 * `builtInDir` that hold a regular-file `SKILL.md`. A failure to read `builtInDir`
 * itself propagates with its original error.
 */
export async function readBuiltInSkillNames(
  builtInDir: string = defaultBuiltInDir,
): Promise<string[]> {
  const entries = await readdir(builtInDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const file = join(builtInDir, entry.name, "SKILL.md");
    const isFile = await stat(file).then(
      (info) => info.isFile(),
      () => false,
    );
    if (isFile) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

async function readRepositorySkill(
  role: RoleName,
  path: string,
  workspace: string,
): Promise<string> {
  const fail = (reason: string, cause?: unknown) => {
    const message = `$.skills.${role}.path ${JSON.stringify(path)} ${reason}`;
    return new ConfigError("CONFIG_SKILL_PATH_INVALID", message, cause);
  };
  if (path.includes("\0")) {
    throw fail("contains a NUL character");
  }
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) {
    throw fail("must be relative to the workspace");
  }
  if (!path.endsWith(".md")) {
    throw fail("must name a .md file");
  }
  const found = await resolveWorkspaceFile(await realpath(workspace), path);
  if (found === undefined) {
    throw fail("does not exist");
  }
  if (!("path" in found)) {
    throw fail(found.reason, found.cause);
  }
  if (!found.path.endsWith(".md")) {
    throw fail("resolves to a file that is not .md");
  }
  try {
    return utf8.decode(await readFile(found.path));
  } catch (error) {
    throw fail("is not UTF-8 text", error);
  }
}

/**
 * The role's skill text: the built-in skill, with the repository file appended
 * (`extend`) or the repository file alone (`override`). A role that is not a built-in
 * skill is `CONFIG_INVALID`, naming the skills that exist.
 */
export async function resolveRoleSkill(
  role: RoleName,
  config: NibfinConfig,
  options: ResolveRoleSkillOptions,
): Promise<string> {
  const builtInDir = options.builtInDir ?? defaultBuiltInDir;
  const names = await readBuiltInSkillNames(builtInDir);
  if (!names.includes(role)) {
    const known = names.join(", ");
    const message = `${JSON.stringify(role)} is not a skill; the skills are ${known}`;
    throw new ConfigError("CONFIG_INVALID", message);
  }
  const builtInFile = join(builtInDir, role, "SKILL.md");
  const setting = config.skills[role];
  if (setting === undefined) {
    return readFile(builtInFile, "utf8");
  }
  const text = await readRepositorySkill(role, setting.path, options.workspace);
  if (setting.mode === "override") {
    return text;
  }
  const builtIn = await readFile(builtInFile, "utf8");
  return `${builtIn.trimEnd()}\n\n${text}`;
}
