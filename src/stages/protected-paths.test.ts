import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import type { NibfinConfig } from "../config/index.ts";
import { fakeActor } from "../github/fake-github.test.ts";
import { commitFile, fixtureGit, git, makeGitFixture } from "./fake-git.test.ts";
import { fetchWorkspaceBranch, prepareBranch } from "./git.ts";
import {
  isUnprotected,
  matchProtected,
  protectedChanges,
  protectedPathError,
  protectedPaths,
  type ProtectedSet,
} from "./protected-paths.ts";

const fixed = [
  "d:.github/workflows",
  "d:.nibfin",
  "d:.rulesync",
  "f:.nibfin.json",
  "f:CODEOWNERS",
  "f:.github/CODEOWNERS",
  "f:docs/CODEOWNERS",
];

function skills(paths: Partial<Record<"shape" | "deliver" | "accept", string>>) {
  const config: NibfinConfig = { tools: {}, skills: {} };
  for (const [role, path] of Object.entries(paths)) {
    config.skills[role as "deliver"] = { path, mode: "extend" };
  }
  return config;
}

function write(root: string, path: string, text = `${path}\n`) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function link(root: string, path: string, target: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  symlinkSync(target, join(root, path));
}

const keys = (set: ProtectedSet) =>
  set.map((entry) => `${entry.directory ? "d" : "f"}:${entry.path}`);

/** The entries beyond the fixed paths of Proposal §3. */
const extra = (set: ProtectedSet) =>
  keys(set)
    .filter((key) => !fixed.includes(key))
    .sort();

describe("protectedPaths", () => {
  it("protects the fixed paths without skills", async () => {
    const root = await makeTempDir("protected-");
    assert.deepEqual(keys(await protectedPaths(skills({}), root)), fixed);
  });

  it("protects configured skills wherever they lie", async () => {
    const root = await makeTempDir("protected-");
    write(root, "docs/deliver.md");
    const config = skills({
      deliver: "./docs/deliver.md",
      accept: "docs/missing.md",
      shape: "docs/deliver.md",
    });
    assert.deepEqual(extra(await protectedPaths(config, root)), [
      "f:docs/deliver.md",
      "f:docs/missing.md",
    ]);
  });

  it("skips paths that cannot name a repository file", async () => {
    const root = await makeTempDir("protected-");
    for (const path of ["/abs/x.md", "../x.md", "a\0.md", ".", "docs/.."]) {
      assert.deepEqual(extra(await protectedPaths(skills({ deliver: path }), root)), []);
    }
  });

  it("protects a skill symlink and its target", async () => {
    const root = await makeTempDir("protected-");
    write(root, "guides/real.md");
    link(root, "docs/deliver.md", "../guides/./real.md");
    const set = await protectedPaths(skills({ deliver: "docs/deliver.md" }), root);
    assert.deepEqual(extra(set), ["f:docs/deliver.md", "f:guides/real.md"]);
  });

  it("protects a symlinked parent, the named path and the real path", async () => {
    const root = await makeTempDir("protected-");
    write(root, "guides/deliver.md");
    link(root, "docs", "guides/");
    const set = await protectedPaths(skills({ deliver: "docs/deliver.md" }), root);
    assert.deepEqual(extra(set), ["f:docs", "f:docs/deliver.md", "f:guides/deliver.md"]);
  });

  it("follows a chain of links, also absolute ones inside the workspace", async () => {
    const root = await makeTempDir("protected-");
    write(root, "c/deliver.md");
    link(root, "a", join(root, "b"));
    link(root, "b", "c");
    const set = await protectedPaths(skills({ deliver: "a/deliver.md" }), root);
    assert.deepEqual(extra(set), ["f:a", "f:a/deliver.md", "f:b", "f:c/deliver.md"]);
  });

  it("protects the directory a .rulesync link points at as a directory", async () => {
    const root = await makeTempDir("protected-");
    mkdirSync(join(root, "config/rules"), { recursive: true });
    link(root, ".rulesync", "config/rules");
    assert.deepEqual(extra(await protectedPaths(skills({}), root)), [
      "d:config/rules",
      "f:.rulesync",
    ]);
  });

  it("records a link that leaves the workspace but not its target", async () => {
    const root = await makeTempDir("protected-");
    const outside = await makeTempDir("outside-");
    write(outside, "deliver.md");
    link(root, "out.md", join(outside, "deliver.md"));
    link(root, "up", "../outside");
    const config = skills({ deliver: "out.md", accept: "up/accept.md" });
    assert.deepEqual(extra(await protectedPaths(config, root)), [
      "f:out.md",
      "f:up",
      "f:up/accept.md",
    ]);
  });

  it("stops after too many hops in a link loop", async () => {
    const root = await makeTempDir("protected-");
    link(root, "a", "b");
    link(root, "b", "a");
    const set = await protectedPaths(skills({ deliver: "a/deliver.md" }), root);
    assert.deepEqual(extra(set), ["f:a", "f:a/deliver.md", "f:b"]);
  });
});

describe("matchProtected", () => {
  it("matches protected paths, their contents and their parents only", async () => {
    const root = await makeTempDir("protected-");
    write(root, "guides/deliver.md");
    link(root, "docs", "guides");
    const set = await protectedPaths(skills({ deliver: "docs/deliver.md" }), root);
    const paths = [
      ".github/workflows/ci.yml",
      ".github",
      ".nibfin.json",
      ".nibfin/x",
      ".rulesync/rules/a.md",
      "CODEOWNERS",
      ".github/CODEOWNERS",
      "docs/CODEOWNERS",
      "docs",
      "docs/deliver.md",
      "guides",
      "guides/deliver.md",
      // Similar but unprotected.
      "docs/CODEOWNERS.md",
      "github/workflows/x",
      ".github/dependabot.yml",
      ".nibfin.json.bak",
      "codeowners",
      "src/x.ts",
      "skills/deliver/SKILL.md",
      "guides/other.md",
      ".rulesyncx",
    ];
    assert.deepEqual(matchProtected(paths, set), paths.slice(0, 12));
  });
});

describe("protectedChanges", () => {
  const branch = "nibfin/issue-1";
  const config = skills({ deliver: "docs/deliver.md" });

  /** A branch forked from base commit A, after the base advanced to B. */
  async function staleBranch(options: { touch?: string } = {}) {
    const fixture = await makeGitFixture("protected-");
    const { other } = fixture;
    write(other, "docs/deliver.md", "old\n");
    write(other, ".rulesync/rules.md", "old\n");
    write(other, ".github/workflows/ci.yml", "old\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "A");
    git(other, "push", "--quiet", "origin", "main");
    git(other, "checkout", "--quiet", "-b", branch);
    write(other, "src/x.txt", "x\n");
    if (options.touch !== undefined) {
      write(other, options.touch, "mine\n");
    }
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "branch work");
    git(other, "push", "--quiet", "origin", branch);
    git(other, "checkout", "--quiet", "main");
    write(other, "docs/deliver.md", "new\n");
    write(other, ".rulesync/rules.md", "new\n");
    write(other, ".github/workflows/ci.yml", "new\n");
    git(other, "commit", "--quiet", "-am", "B");
    git(other, "push", "--quiet", "origin", "main");
    git(fixture.workspace, "pull", "--quiet", "origin", "main");
    const subject = fixtureGit(fixture);
    const set = await protectedPaths(config, fixture.workspace);
    await prepareBranch(subject, { base: "main", branch, actor: fakeActor });
    const changes = async () =>
      protectedChanges(subject, "main", await fetchWorkspaceBranch(subject, branch), set);
    return { fixture, changes };
  }

  it("finds protected paths a stale branch carries in an older version", async () => {
    const { fixture, changes } = await staleBranch();
    const found = await changes();
    assert.deepEqual(found, {
      changedOnBranch: [],
      behindBase: [".github/workflows/ci.yml", ".rulesync/rules.md", "docs/deliver.md"],
    });
    assert.equal(isUnprotected(found), false);
    // A merge-base diff alone sees only the branch's own change.
    const own = git(fixture.workspace, "diff", "--name-only", "origin/main...HEAD");
    assert.equal(own, "src/x.txt");
    git(fixture.workspace, "rebase", "--quiet", "origin/main");
    const rebased = await changes();
    assert.deepEqual(rebased, { changedOnBranch: [], behindBase: [] });
    assert.equal(isUnprotected(rebased), true);
  });

  it("splits changes on the branch from those behind the base", async () => {
    const { fixture, changes } = await staleBranch({ touch: "docs/deliver.md" });
    commitFile(fixture.workspace, "CODEOWNERS", "* @x\n", "owners");
    assert.deepEqual(await changes(), {
      changedOnBranch: ["CODEOWNERS", "docs/deliver.md"],
      behindBase: [".github/workflows/ci.yml", ".rulesync/rules.md"],
    });
  });

  it("lists both sides of a rename", async () => {
    const { fixture, changes } = await staleBranch();
    git(fixture.workspace, "rebase", "--quiet", "origin/main");
    git(fixture.workspace, "mv", "docs/deliver.md", "src/deliver.md");
    git(fixture.workspace, "commit", "--quiet", "-m", "move");
    assert.deepEqual(await changes(), {
      changedOnBranch: ["docs/deliver.md"],
      behindBase: [],
    });
  });
});

describe("protectedPathError", () => {
  it("names each group with its route and leaves out an empty one", () => {
    const both = protectedPathError("b", "main", {
      changedOnBranch: [".nibfin.json"],
      behindBase: ["docs/deliver.md"],
    });
    assert.equal(both.code, "STAGE_PROTECTED_PATH");
    assert.equal(
      both.message,
      "b differs from origin/main on protected paths. Nibfin does not push or " +
        "accept a head whose protected paths differ from origin/main.\n\n" +
        "Changed on the branch: these changes belong to a separately authorized " +
        "maintenance route outside Nibfin's delivery and must be removed from the " +
        "branch.\n- .nibfin.json\n\n" +
        "Only behind the base: the branch carries an older version than main and " +
        "must be updated from the base (rebased onto origin/main) before Deliver " +
        "can continue.\n- docs/deliver.md",
    );
    const own = protectedPathError("b", "main", {
      changedOnBranch: ["x"],
      behindBase: [],
    });
    assert.doesNotMatch(own.message, /behind the base/);
    const behind = protectedPathError("b", "main", {
      changedOnBranch: [],
      behindBase: ["x"],
    });
    assert.doesNotMatch(behind.message, /Changed on the branch/);
  });
});
