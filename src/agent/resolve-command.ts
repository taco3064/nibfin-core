import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { AgentError } from "./errors.ts";
import type { Command } from "./process.ts";

const scriptExtensions = new Set([".js", ".mjs", ".cjs"]);

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** True for a JavaScript file or a script whose `#!` line runs `node`. */
async function isNodeScript(path: string): Promise<boolean> {
  if (scriptExtensions.has(extname(path))) {
    return true;
  }
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(256), 0, 256, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    return firstLine.startsWith("#!") && /\bnode\b/.test(firstLine);
  } finally {
    await file.close();
  }
}

function candidates(name: string, cwd: string, path: string | undefined): string[] {
  if (isAbsolute(name) || name.includes("/")) {
    return [resolve(cwd, name)];
  }
  const dirs = (path ?? "").split(delimiter).filter((dir) => dir !== "");
  return dirs.map((dir) => join(dir, name));
}

/**
 * Resolves `command` to an absolute executable, looking a bare name up in `path`
 * (the unmodified Job `PATH`). A Node.js script, such as an npm-installed CLI's bin
 * script, runs through Core's own Node (`process.execPath`), never through
 * `env node` on a changed `PATH`.
 */
export async function resolveCommand(
  command: Command,
  cwd: string,
  path: string | undefined,
): Promise<Command> {
  for (const candidate of candidates(command.command, cwd, path)) {
    if (await isExecutableFile(candidate)) {
      const real = await realpath(candidate);
      return (await isNodeScript(real))
        ? { command: process.execPath, args: [real, ...command.args] }
        : { command: real, args: command.args };
    }
  }
  const message = `${command.command} is not an executable on PATH`;
  throw new AgentError("AGENT_RUN_FAILED", message, {});
}
