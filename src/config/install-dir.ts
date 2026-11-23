import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDirectory } from "../agent/fs.ts";
import { ConfigError, messageOf } from "./errors.ts";

function installFailure(tool: string, version: string, cause: unknown): ConfigError {
  const message = `Could not install ${tool} ${version}: ${messageOf(cause)}`;
  return new ConfigError("TOOL_INSTALL_FAILED", message, cause);
}

/**
 * Installs `<cacheRoot>/<tool>/<version>` once. `install` fills a unique temporary
 * directory that is then renamed into place, so only a finished directory counts
 * as installed. When another Job renamed first, its result is used. The temporary
 * directory is removed on any failure or collision. Returns the final directory.
 */
export async function installOnce(
  cacheRoot: string,
  tool: string,
  version: string,
  install: (dir: string) => Promise<void>,
): Promise<string> {
  const toolDir = join(cacheRoot, tool);
  const final = join(toolDir, version);
  if (isDirectory(final)) {
    return final;
  }
  await mkdir(toolDir, { recursive: true });
  const temp = await mkdtemp(join(toolDir, `.${version}-`));
  const removeTemp = () => rm(temp, { recursive: true, force: true });
  try {
    await install(temp);
  } catch (error) {
    await removeTemp();
    throw installFailure(tool, version, error);
  }
  try {
    await rename(temp, final);
  } catch (error) {
    await removeTemp();
    if (isDirectory(final)) {
      return final;
    }
    throw installFailure(tool, version, error);
  }
  return final;
}
