import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isWithin } from "../config/paths.ts";
import { type NibfinConfig, roleNames } from "../config/schema.ts";
import { StageError } from "./errors.ts";
import type { Git } from "./git.ts";

/**
 * One protected path, POSIX and relative to the repository root. A directory entry
 * also covers everything below it.
 */
export interface ProtectedEntry {
  path: string;
  directory: boolean;
}

export type ProtectedSet = readonly ProtectedEntry[];

/** Proposal §3: the agent's own execution policy, workflows, rules and CODEOWNERS. */
const protectedDirectories = [".github/workflows", ".nibfin", ".rulesync"];
const protectedFiles = [
  ".nibfin.json",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
];

/** Symlinks followed for one path before the walk gives up, as the OS does. */
const maxHops = 40;

/** `path` as a normalized repository path, or `undefined` when it cannot be one. */
function repositoryPath(path: string): string | undefined {
  if (path.includes("\0") || posix.isAbsolute(path)) {
    return undefined;
  }
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

interface Walk {
  /** Every symlink the walk passed through, as repository paths. */
  links: string[];
  /** The real path inside the workspace, when the walk reached it. */
  real: string | undefined;
}

/**
 * Resolves `path` below the real directory `root` one part at a time, as the OS
 * does, and records each symlink on the way. Stops at a missing part, a link that
 * leaves the workspace or too many hops; the links seen so far stay recorded.
 */
async function walk(root: string, path: string): Promise<Walk> {
  const links: string[] = [];
  let done: string[] = [];
  let rest = path.split("/");
  let hops = 0;
  const stop = () => ({ links, real: undefined });
  while (rest.length > 0) {
    const part = rest.shift()!;
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (done.length === 0) {
        return stop();
      }
      done.pop();
      continue;
    }
    const current = [...done, part].join("/");
    const absolute = join(root, current);
    const info = await lstat(absolute).catch(() => undefined);
    if (info === undefined) {
      return stop();
    }
    if (!info.isSymbolicLink()) {
      done.push(part);
      continue;
    }
    links.push(current);
    hops += 1;
    if (hops > maxHops) {
      return stop();
    }
    let target = await readlink(absolute);
    if (isAbsolute(target)) {
      const resolved = resolve(target);
      if (!isWithin(root, resolved)) {
        return stop();
      }
      done = [];
      target = relative(root, resolved).split(sep).join("/");
    }
    rest = [...target.split("/"), ...rest];
  }
  return { links, real: done.join("/") };
}

/**
 * The protected paths of a run, read from the base checkout before the Issue branch
 * is checked out: the fixed directories and files of Proposal §3, every role skill
 * file `config` names, each symlink on the way to one of them, and the in-workspace
 * real path it resolves to (with the same kind).
 */
export async function protectedPaths(
  config: NibfinConfig,
  workspace: string,
): Promise<ProtectedSet> {
  const root = await realpath(workspace);
  const named: ProtectedEntry[] = [
    ...protectedDirectories.map((path) => ({ path, directory: true })),
    ...protectedFiles.map((path) => ({ path, directory: false })),
  ];
  for (const role of roleNames) {
    const setting = config.skills[role];
    if (setting !== undefined) {
      named.push({ path: setting.path, directory: false });
    }
  }
  const entries = new Map<string, ProtectedEntry>();
  const add = (entry: ProtectedEntry) => {
    entries.set(`${entry.directory ? "d" : "f"}:${entry.path}`, entry);
  };
  for (const entry of named) {
    const path = repositoryPath(entry.path);
    if (path === undefined) {
      // resolveRoleSkill rejects such a path, and no diff can list it.
      continue;
    }
    add({ path, directory: entry.directory });
    const { links, real } = await walk(root, path);
    for (const link of links) {
      add({ path: link, directory: false });
    }
    if (real !== undefined && real !== path) {
      add({ path: real, directory: entry.directory });
    }
  }
  return [...entries.values()];
}

/** Whether the repository path `path` is protected by `entry`. */
function matches(path: string, entry: ProtectedEntry): boolean {
  return (
    path === entry.path ||
    (entry.directory && path.startsWith(`${entry.path}/`)) ||
    // A symlink or file that replaces a parent directory is listed under its own path.
    entry.path.startsWith(`${path}/`)
  );
}

/** The paths among `paths` that the set protects, case-sensitively as Git does. */
export function matchProtected(
  paths: readonly string[],
  protectedSet: ProtectedSet,
): string[] {
  return paths.filter((path) => protectedSet.some((entry) => matches(path, entry)));
}

export interface ProtectedChanges {
  /** Protected paths that differ from the base and that the branch itself changed. */
  changedOnBranch: string[];
  /** Protected paths that differ only because the branch is behind the base. */
  behindBase: string[];
}

/** True when there is no protected difference. */
export function isUnprotected(changes: ProtectedChanges): boolean {
  return changes.changedOnBranch.length === 0 && changes.behindBase.length === 0;
}

async function changedPaths(git: Git, range: string[]): Promise<Set<string>> {
  const args = ["diff", "--name-only", "--no-renames", "-z", ...range];
  const output = await git.coreRequired(args);
  return new Set(output.split("\0").filter((path) => path !== ""));
}

/**
 * Compares `head` with the current tree of `refs/remotes/origin/<base>` in Core's
 * repository. It is a two-dot comparison, so a head that only carries an older
 * version of a protected path differs too; the merge-base diff then tells which of
 * the differing paths the branch changed itself.
 */
export async function protectedChanges(
  git: Git,
  base: string,
  head: string,
  protectedSet: ProtectedSet,
): Promise<ProtectedChanges> {
  const baseRef = `refs/remotes/origin/${base}`;
  const paths = [...(await changedPaths(git, [baseRef, head]))];
  const differing = matchProtected(paths, protectedSet).sort();
  if (differing.length === 0) {
    return { changedOnBranch: [], behindBase: [] };
  }
  const own = await changedPaths(git, [`${baseRef}...${head}`]);
  return {
    changedOnBranch: differing.filter((path) => own.has(path)),
    behindBase: differing.filter((path) => !own.has(path)),
  };
}

interface TreeEntry {
  mode: string;
  oid: string;
}

/** The non-tree entries of `head` that the set protects, from Core's repository. */
async function protectedTree(
  git: Git,
  head: string,
  protectedSet: ProtectedSet,
): Promise<Map<string, TreeEntry>> {
  const output = await git.coreRequired(["ls-tree", "-r", "-z", "--full-tree", head]);
  const entries = new Map<string, TreeEntry>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const [mode, , oid] = record.slice(0, tab).split(" ") as [string, string, string];
    const path = record.slice(tab + 1);
    if (matchProtected([path], protectedSet).length > 0) {
      entries.set(path, { mode, oid });
    }
  }
  return entries;
}

/** Each parent of `path`, shortest first, then `path` itself. */
function prefixes(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * The protected paths whose state in the workspace's working tree differs from
 * `head`, read from the file system and Core's repository only. Nothing in the
 * workspace's index or Git config (skip-worktree, assume-unchanged, fsmonitor,
 * ignore rules, stat data) takes part, so none of it can hide a difference from
 * what rulesync and the Acceptor read. The executable bit is not compared.
 */
export async function workingTreeChanges(
  git: Git,
  workspace: string,
  head: string,
  protectedSet: ProtectedSet,
): Promise<string[]> {
  const root = await realpath(workspace);
  const format = (await git.coreRequired(["rev-parse", "--show-object-format"])).trim();
  const hash = (bytes: Buffer) =>
    createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const tree = await protectedTree(git, head, protectedSet);
  const info = (path: string) => lstat(join(root, path)).catch(() => undefined);
  const differing = new Set<string>();

  // Every protected entry of the head is in the working tree, unchanged, and reached
  // through real directories only (a tree entry has no link above it).
  for (const [path, entry] of tree) {
    let reachable = true;
    for (const parent of prefixes(path).slice(0, -1)) {
      if (!(await info(parent))?.isDirectory()) {
        reachable = false;
        break;
      }
    }
    const stat = reachable ? await info(path) : undefined;
    const absolute = join(root, path);
    let same = false;
    if (stat === undefined) {
      same = false;
    } else if (entry.mode === "120000") {
      same =
        stat.isSymbolicLink() &&
        hash(await readlink(absolute, { encoding: "buffer" })) === entry.oid;
    } else if (entry.mode === "160000") {
      same = stat.isDirectory();
    } else {
      same = stat.isFile() && hash(await readFile(absolute)) === entry.oid;
    }
    if (!same) {
      differing.add(path);
    }
  }

  // Nothing the head lacks sits on or below a protected path, or replaces a parent
  // directory of one; ignored and untracked files included.
  const below = async (directory: string): Promise<void> => {
    if (tree.get(directory)?.mode === "160000") {
      return;
    }
    const names = await readdir(join(root, directory));
    for (const name of names) {
      const path = `${directory}/${name}`;
      const stat = await info(path);
      if (stat?.isDirectory()) {
        await below(path);
      } else if (!tree.has(path)) {
        differing.add(path);
      }
    }
  };
  for (const entry of protectedSet) {
    for (const path of prefixes(entry.path)) {
      const stat = await info(path);
      if (stat === undefined) {
        break;
      }
      if (!stat.isDirectory()) {
        if (!tree.has(path)) {
          differing.add(path);
        }
        break;
      }
      if (path === entry.path) {
        await below(path);
      }
    }
  }
  return [...differing].sort();
}

const list = (paths: readonly string[]) => paths.map((path) => `- ${path}`).join("\n");

/** `STAGE_PROTECTED_PATH`: the head differs from the base on protected paths. */
export function protectedPathError(
  branch: string,
  base: string,
  changes: ProtectedChanges,
): StageError {
  const parts = [
    `${branch} differs from origin/${base} on protected paths. Nibfin does not push ` +
      `or accept a head whose protected paths differ from origin/${base}.`,
  ];
  if (changes.changedOnBranch.length > 0) {
    parts.push(
      "Changed on the branch: these changes belong to a separately authorized " +
        "maintenance route outside Nibfin's delivery and must be removed from the " +
        `branch.\n${list(changes.changedOnBranch)}`,
    );
  }
  if (changes.behindBase.length > 0) {
    parts.push(
      `Only behind the base: the branch carries an older version than ${base} and ` +
        `must be updated from the base (rebased onto origin/${base}) before Deliver ` +
        `can continue.\n${list(changes.behindBase)}`,
    );
  }
  return new StageError("STAGE_PROTECTED_PATH", parts.join("\n\n"));
}
