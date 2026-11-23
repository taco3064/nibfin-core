import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "./errors.ts";
import { isDirectory, readOptionalFile } from "./fs.ts";
import { gitPath } from "./git-path.ts";
import { isRecord, type JsonRecord, parseJsonRecord } from "./json.ts";
import { type Command, describeExit, runCaptured } from "./process.ts";

export const rulesyncFeatures = "rules,mcp,skills";

export interface GenerateAgentConfigOptions {
  workspace: string;
  /** The rulesync target, such as `claudecode` or `codexcli`. */
  target: string;
  rulesync: Command;
}

function planOperations(document: JsonRecord | undefined): unknown[] | undefined {
  const data = document?.data;
  const plan = isRecord(data) ? data.plan : undefined;
  const operations = isRecord(plan) ? plan.operations : undefined;
  return Array.isArray(operations) ? operations : undefined;
}

/** The files a `rulesync --json generate` run wrote, relative to the workspace. */
function writtenPaths(stdout: string): string[] | undefined {
  const operations = planOperations(parseJsonRecord(stdout));
  if (operations === undefined) {
    return undefined;
  }
  const paths = operations
    .filter(isRecord)
    .filter((operation) => operation.action === "write")
    .map((operation) => operation.path)
    .filter((path) => typeof path === "string");
  return [...new Set(paths)];
}

/** An anchored gitignore pattern that matches exactly `path`. */
export function excludePattern(path: string): string {
  return `/${path.replace(/[\\*?[\] ]/g, "\\$&")}`;
}

/** Appends `paths` to the repository's `info/exclude` so they are never committed. */
export async function excludeFromGit(
  workspace: string,
  paths: readonly string[],
): Promise<void> {
  const file = await gitPath(workspace, "info/exclude");
  const existing = (await readOptionalFile(file)) ?? "";
  const present = new Set(existing.split(/\r?\n/));
  const additions = paths.map(excludePattern).filter((pattern) => !present.has(pattern));
  if (additions.length === 0) {
    return;
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${separator}${additions.join("\n")}\n`);
}

/**
 * Generates the provider's rules, MCP and skill files from `.rulesync/` and
 * keeps them out of commits. A workspace without `.rulesync/` is left as is.
 * Returns the generated paths.
 */
export async function generateAgentConfig(
  options: GenerateAgentConfigOptions,
): Promise<string[]> {
  const { workspace, target, rulesync } = options;
  if (!isDirectory(join(workspace, ".rulesync"))) {
    return [];
  }
  const args = [
    "--json",
    "generate",
    "--targets",
    target,
    "--features",
    rulesyncFeatures,
  ];
  const { status, stdout, stderr } = await runCaptured({
    command: rulesync,
    args,
    cwd: workspace,
    env: process.env,
  });
  const output = `${stdout}${stderr}`;
  if (status.exitCode !== 0) {
    const message = `rulesync generate failed with ${describeExit(status)}`;
    throw new AgentError("AGENT_CONFIG_GENERATION_FAILED", message, {
      exitCode: status.exitCode,
      output,
    });
  }
  const paths = writtenPaths(stdout);
  if (paths === undefined) {
    const message = "rulesync generate printed no file plan";
    throw new AgentError("AGENT_CONFIG_GENERATION_FAILED", message, {
      exitCode: 0,
      output,
    });
  }
  await excludeFromGit(workspace, paths);
  return paths;
}
