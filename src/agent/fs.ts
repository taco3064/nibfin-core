import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Reads a UTF-8 file, or returns `undefined` when it does not exist. */
export async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** True for an existing directory; other errors than absence are thrown. */
export function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
