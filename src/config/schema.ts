import { readFile, realpath } from "node:fs/promises";
import { isRecord } from "../agent/json.ts";
import { ConfigError, messageOf } from "./errors.ts";
import { resolveWorkspaceFile } from "./paths.ts";

export const configFileName = ".nibfin.json";
export const toolNames = ["node", "python", "go"] as const;
export const roleNames = ["shape", "deliver", "accept"] as const;
export const skillModes = ["extend", "override"] as const;

export type ToolName = (typeof toolNames)[number];
export type RoleName = (typeof roleNames)[number];
export type SkillMode = (typeof skillModes)[number];
export type ToolVersions = Partial<Record<ToolName, string>>;

export interface SkillSetting {
  mode: SkillMode;
  /** Relative to the workspace. */
  path: string;
}

export interface NibfinConfig {
  tools: ToolVersions;
  skills: Partial<Record<RoleName, SkillSetting>>;
}

/** Settings that were removed from the product and now make the file invalid. */
const removedKeys = new Set(["allowedDomains", "writerBackend"]);
const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const minorRelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Problems = string[];

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  return value === null ? "null" : `a ${typeof value}`;
}

function objectAt(value: unknown, path: string, problems: Problems) {
  if (isRecord(value)) {
    return value;
  }
  problems.push(`${path}: expected an object, got ${describe(value)}`);
  return undefined;
}

function checkKeys(
  object: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  problems: Problems,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      const note = path === "$" && removedKeys.has(key) ? " (removed from Nibfin)" : "";
      problems.push(`${childPath(path, key)}: unknown key${note}`);
    }
  }
}

/** An exact `x.y.z` release; Go also takes `x.y`. */
export function isVersion(tool: ToolName, value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return release.test(value) || (tool === "go" && minorRelease.test(value));
}

function readTools(value: unknown, problems: Problems): ToolVersions {
  const tools: ToolVersions = {};
  const object = objectAt(value, "$.tools", problems);
  if (object === undefined) {
    return tools;
  }
  checkKeys(object, "$.tools", toolNames, problems);
  for (const tool of toolNames.filter((name) => Object.hasOwn(object, name))) {
    const version = object[tool];
    if (isVersion(tool, version)) {
      tools[tool] = version;
    } else {
      const expected = tool === "go" ? '"x.y.z" or "x.y"' : '"x.y.z"';
      const got = JSON.stringify(version);
      problems.push(`$.tools.${tool}: expected a version ${expected}, got ${got}`);
    }
  }
  return tools;
}

function readSkill(value: unknown, path: string, problems: Problems) {
  const object = objectAt(value, path, problems);
  if (object === undefined) {
    return undefined;
  }
  checkKeys(object, path, ["mode", "path"], problems);
  const { mode, path: file } = object;
  const validMode = skillModes.find((name) => name === mode);
  if (validMode === undefined) {
    problems.push(`${path}.mode: expected "extend" or "override"`);
  }
  if (typeof file !== "string") {
    problems.push(`${path}.path: expected a string`);
  }
  if (validMode === undefined || typeof file !== "string") {
    return undefined;
  }
  return { mode: validMode, path: file };
}

function readSkills(value: unknown, problems: Problems): NibfinConfig["skills"] {
  const skills: NibfinConfig["skills"] = {};
  const object = objectAt(value, "$.skills", problems);
  if (object === undefined) {
    return skills;
  }
  checkKeys(object, "$.skills", roleNames, problems);
  for (const role of roleNames.filter((name) => Object.hasOwn(object, name))) {
    const skill = readSkill(object[role], `$.skills.${role}`, problems);
    if (skill !== undefined) {
      skills[role] = skill;
    }
  }
  return skills;
}

/** Validates `.nibfin.json` text; every problem is listed with its JSON path. */
export function parseNibfinConfig(text: string): NibfinConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = `${configFileName} is not valid JSON: ${messageOf(error)}`;
    throw new ConfigError("CONFIG_INVALID", message, error);
  }
  const problems: Problems = [];
  const config: NibfinConfig = { tools: {}, skills: {} };
  const root = objectAt(value, "$", problems);
  if (root !== undefined) {
    checkKeys(root, "$", ["tools", "skills"], problems);
    if (Object.hasOwn(root, "tools")) {
      config.tools = readTools(root.tools, problems);
    }
    if (Object.hasOwn(root, "skills")) {
      config.skills = readSkills(root.skills, problems);
    }
  }
  if (problems.length > 0) {
    const list = problems.map((problem) => `- ${problem}`).join("\n");
    throw new ConfigError("CONFIG_INVALID", `${configFileName} is invalid:\n${list}`);
  }
  return config;
}

/**
 * Reads the workspace's `.nibfin.json`. A missing file gives the defaults: no tools
 * and the built-in skills. The file must resolve to a regular file inside the
 * workspace.
 */
export async function readNibfinConfig(workspace: string): Promise<NibfinConfig> {
  const root = await realpath(workspace);
  const found = await resolveWorkspaceFile(root, configFileName);
  if (found === undefined) {
    return { tools: {}, skills: {} };
  }
  if (!("path" in found)) {
    const message = `${configFileName} ${found.reason}`;
    throw new ConfigError("CONFIG_INVALID", message, found.cause);
  }
  return parseNibfinConfig(await readFile(found.path, "utf8"));
}
