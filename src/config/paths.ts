import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** True when `target` is `root` or lies below it. Both paths must be absolute. */
export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export interface FileProblem {
  reason: string;
  cause?: unknown;
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Resolves `relativePath` below the real directory `root`, following symlinks.
 * Returns the real file path, a problem, or `undefined` when nothing is there.
 */
export async function resolveWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<{ path: string } | FileProblem | undefined> {
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    return { reason: "points outside the workspace" };
  }
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if (!isAbsent(error)) {
      return { reason: "cannot be resolved", cause: error };
    }
    const exists = await lstat(candidate).then(
      () => true,
      () => false,
    );
    return exists ? { reason: "is a symlink to a missing file" } : undefined;
  }
  if (!isWithin(root, target)) {
    return { reason: "resolves outside the workspace" };
  }
  if (!(await stat(target)).isFile()) {
    return { reason: "is not a regular file" };
  }
  return { path: target };
}
