import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "./errors.ts";
import { readOptionalFile } from "./fs.ts";
import { isRecord, type JsonRecord } from "./json.ts";

/** The Claude Code user setting that loads a project's `.mcp.json` servers. */
export const projectMcpSetting = "enableAllProjectMcpServers";

async function readSettings(file: string): Promise<JsonRecord> {
  const text = await readOptionalFile(file);
  if (text === undefined) {
    return {};
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new AgentError("AGENT_CONFIG_INVALID", `${file} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(settings)) {
    throw new AgentError("AGENT_CONFIG_INVALID", `${file} is not a JSON object`, {});
  }
  return settings;
}

/**
 * Sets `enableAllProjectMcpServers: true` in `<home>/settings.json` and keeps
 * every other key. The file is replaced atomically and left untouched when the
 * setting is already on.
 */
export async function enableProjectMcpServers(home: string): Promise<void> {
  const file = join(home, "settings.json");
  const settings = await readSettings(file);
  if (settings[projectMcpSetting] === true) {
    return;
  }
  const merged = { ...settings, [projectMcpSetting]: true };
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(home, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`);
  await rename(temporary, file);
}
