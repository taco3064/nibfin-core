import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCaptured } from "../agent/process.ts";
import { installGo, installNode } from "./archives.ts";
import { ConfigError } from "./errors.ts";
import type {
  FetchLike,
  InstallContext,
  RunTool,
  ToolExecutables,
} from "./install-context.ts";
import { installOnce } from "./install-dir.ts";
import { isWithin } from "./paths.ts";
import { installPython } from "./python.ts";
import { type ToolName, toolNames, type ToolVersions } from "./schema.ts";

export interface PrepareToolsOptions {
  /** The Job's checkout; the cache must lie outside it. */
  workspace: string;
  /** Shared by Jobs; holds `<tool>/<version>`. */
  cacheDir: string;
  fetch?: FetchLike;
  run?: RunTool;
  executables?: Partial<ToolExecutables>;
  /** Defaults to `process.arch`. */
  arch?: string;
}

export const defaultToolExecutables: ToolExecutables = {
  tar: { command: "tar", args: [] },
  uv: { command: "uv", args: [] },
};

type Installer = (context: InstallContext, version: string, dir: string) => Promise<void>;

const installers: Record<ToolName, Installer> = {
  node: installNode,
  python: installPython,
  go: installGo,
};

/** The real cache directory, created when missing; never inside the workspace. */
async function cacheRoot(options: PrepareToolsOptions): Promise<string> {
  const workspaces = [resolve(options.workspace), await realpath(options.workspace)];
  const outside = (path: string) => !workspaces.some((root) => isWithin(root, path));
  const requested = resolve(options.cacheDir);
  if (outside(requested)) {
    await mkdir(requested, { recursive: true });
    const real = await realpath(requested);
    if (outside(real)) {
      return real;
    }
  }
  const message = `The tool cache ${requested} must be outside the workspace`;
  throw new ConfigError("TOOL_INSTALL_FAILED", message);
}

/**
 * Installs each declared tool once into the cache and returns the `PATH` entries
 * for the agent's tool processes, in the order Node.js, Python, Go.
 */
export async function prepareTools(
  tools: ToolVersions,
  options: PrepareToolsOptions,
): Promise<string[]> {
  const context: InstallContext = {
    fetch: options.fetch ?? globalThis.fetch,
    run: options.run ?? runCaptured,
    executables: { ...defaultToolExecutables, ...options.executables },
    arch: options.arch ?? process.arch,
  };
  const root = await cacheRoot(options);
  const entries: string[] = [];
  for (const tool of toolNames) {
    const version = tools[tool];
    if (version !== undefined) {
      const install = (dir: string) => installers[tool](context, version, dir);
      entries.push(join(await installOnce(root, tool, version, install), "bin"));
    }
  }
  return entries;
}
