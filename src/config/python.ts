import { mkdir, realpath, symlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { type InstallContext, runChecked } from "./install-context.ts";
import { isWithin } from "./paths.ts";

/**
 * Python through `uv python install`, ignoring every uv configuration file. `bin/`
 * gets `python` and `python3` links, relative so they survive the final rename.
 */
export async function installPython(
  context: InstallContext,
  version: string,
  dir: string,
): Promise<void> {
  const installDir = join(dir, "install");
  const env = {
    UV_NO_CONFIG: "1",
    UV_PYTHON_INSTALL_DIR: installDir,
    UV_PYTHON_BIN_DIR: join(dir, "uv-bin"),
  };
  const uv = context.executables.uv;
  await runChecked(context, uv, ["python", "install", version], dir, env);
  const findArgs = ["python", "find", "--managed-python", version];
  const found = (await runChecked(context, uv, findArgs, dir, env)).trim();
  if (!isAbsolute(found)) {
    throw new Error(`uv python find printed ${JSON.stringify(found)}, not a path`);
  }
  const executable = await realpath(found);
  if (!isWithin(await realpath(installDir), executable)) {
    throw new Error(`uv python find returned ${found}, outside the new installation`);
  }
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const name of ["python", "python3"]) {
    await symlink(relative(bin, executable), join(bin, name));
  }
}
