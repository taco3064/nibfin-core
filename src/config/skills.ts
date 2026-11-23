import { readFile, realpath } from "node:fs/promises";
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
 * (`extend`) or the repository file alone (`override`).
 */
export async function resolveRoleSkill(
  role: RoleName,
  config: NibfinConfig,
  options: ResolveRoleSkillOptions,
): Promise<string> {
  const builtInFile = join(options.builtInDir ?? defaultBuiltInDir, role, "SKILL.md");
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
