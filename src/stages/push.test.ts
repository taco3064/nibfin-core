import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { NibfinConfig } from "../config/index.ts";
import { fakeActor, fakeToken, rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import {
  commitFile,
  fixtureGit,
  git,
  type GitFixture,
  makeGitFixture,
  recordingGit,
} from "./fake-git.test.ts";
import { type GitCall, type GitOutput, prepareBranch } from "./git.ts";
import { protectedPaths } from "./protected-paths.ts";
import { BranchPusher } from "./push.ts";

const branch = "nibfin/issue-1";
const isPush = (call: GitCall) => call.args.includes("push");

async function setup(
  options: {
    pushed?: boolean;
    override?: (call: GitCall) => GitOutput | undefined;
    beforePush?: () => Promise<boolean>;
    /** Commits to `main` before the branch is prepared. */
    base?: (other: string) => void;
    config?: NibfinConfig;
  } = {},
) {
  const fixture = await makeGitFixture("push-");
  if (options.base !== undefined) {
    options.base(fixture.other);
    git(fixture.other, "push", "--quiet", "origin", "main");
    git(fixture.workspace, "pull", "--quiet", "origin", "main");
  }
  if (options.pushed) {
    git(fixture.other, "checkout", "--quiet", "-b", branch);
    commitFile(fixture.other, "o.txt", "o\n", "earlier work");
    git(fixture.other, "push", "--quiet", "origin", branch);
  }
  const recorder = recordingGit(options.override);
  const subject = fixtureGit(fixture, recorder.run);
  const config = options.config ?? { tools: {}, skills: {} };
  const protectedSet = await protectedPaths(config, fixture.workspace);
  const prepared = await prepareBranch(subject, {
    base: "main",
    branch,
    actor: fakeActor,
  });
  const logs: string[] = [];
  /** The number of pushes seen at each `afterPush` call. */
  const afterPushes: number[] = [];
  const pusher = new BranchPusher({
    git: subject,
    base: "main",
    branch,
    protectedSet,
    remoteHead: prepared.remoteHead,
    beforePush: options.beforePush ?? (() => Promise.resolve(true)),
    afterPush: () => void afterPushes.push(pushes().length),
    log: (line) => logs.push(line),
  });
  const pushes = () => recorder.calls.filter(isPush);
  return { fixture, recorder, subject, pusher, logs, pushes, afterPushes };
}

function commit(fixture: GitFixture, name: string): string {
  return commitFile(fixture.workspace, name, `${name}\n`, `add ${name}`);
}

describe("BranchPusher", () => {
  it("pushes a new branch with an empty lease, then leases the pushed head", async () => {
    const t = await setup();
    assert.equal(t.pusher.remoteHead, undefined);
    const first = commit(t.fixture, "a.txt");
    await t.pusher.flush();
    assert.equal(t.fixture.remoteHead(branch), first);
    const second = commit(t.fixture, "b.txt");
    await t.pusher.flush();
    assert.equal(t.fixture.remoteHead(branch), second);
    const [one, two] = t.pushes();
    assert.ok(one.args.includes(`--force-with-lease=refs/heads/${branch}:`));
    assert.ok(two.args.includes(`--force-with-lease=refs/heads/${branch}:${first}`));
    assert.ok(two.args.includes("--no-verify"));
    assert.ok(two.args.includes(`${second}:refs/heads/${branch}`));
    assert.deepEqual(t.logs, [
      `Pushed ${branch} at ${first}`,
      `Pushed ${branch} at ${second}`,
    ]);
    // Fresh GitHub reads follow each push.
    assert.deepEqual(t.afterPushes, [1, 2]);
    for (const call of t.recorder.calls) {
      assert.ok(!call.args.join(" ").includes(fakeToken));
    }
  });

  it("runs no workspace hook or credential helper while the token is set", async () => {
    const t = await setup();
    commit(t.fixture, "a.txt");
    const hooks = join(t.fixture.root, "hooks");
    const marker = join(t.fixture.root, "hook-ran");
    mkdirSync(hooks);
    for (const name of ["pre-push", "reference-transaction"]) {
      const script = join(hooks, name);
      writeFileSync(script, `#!/bin/sh\nenv > "${marker.replaceAll("\\", "/")}"\n`);
      chmodSync(script, 0o755);
    }
    git(t.fixture.workspace, "config", "core.hooksPath", hooks);
    git(t.fixture.workspace, "config", "credential.helper", `!sh -c "env > x"`);
    // The hooks run for Git commands without the token, such as a later commit.
    git(t.fixture.workspace, "update-ref", "refs/nibfin/probe", "HEAD");
    assert.equal(existsSync(marker), true);
    rmSync(marker);
    await t.pusher.flush();
    assert.ok(t.fixture.remoteHead(branch) !== undefined);
    assert.equal(existsSync(marker), false);
  });

  it("pushes from Core's repository, out of reach of workspace config", async () => {
    const t = await setup();
    const evil = join(t.fixture.root, "evil.git");
    git(t.fixture.root, "init", "--quiet", "--bare", evil);
    const { workspace } = t.fixture;
    git(workspace, "config", `url.${evil}.insteadOf`, t.fixture.remote);
    git(workspace, "config", `url.${evil}.pushInsteadOf`, t.fixture.remote);
    git(workspace, "config", "http.proxy", "http://127.0.0.1:9");
    git(workspace, "config", "http.sslVerify", "false");
    const head = commit(t.fixture, "a.txt");
    // The trap is live: a push from the workspace goes to the other repository.
    git(workspace, "push", "--quiet", t.fixture.remote, `HEAD:refs/heads/probe`);
    assert.equal(git(evil, "rev-parse", "refs/heads/probe"), head);
    await t.pusher.flush();
    assert.equal(t.fixture.remoteHead(branch), head);
    assert.throws(() => git(evil, "rev-parse", "--verify", `refs/heads/${branch}`));
    for (const call of t.recorder.calls.filter((c) => c.env.GIT_CONFIG_COUNT)) {
      assert.equal(call.cwd, t.subject.coreRepo);
    }
  });

  it("never pushes a head without commits ahead of the base", async () => {
    const t = await setup();
    await t.pusher.flush();
    assert.deepEqual(t.pushes(), []);
    assert.equal(t.fixture.remoteHead(branch), undefined);
    assert.deepEqual(t.logs, [
      `${branch} has no commits ahead of main; nothing is pushed`,
    ]);
  });

  it("does not push an unchanged head", async () => {
    const t = await setup({ pushed: true });
    await t.pusher.flush();
    assert.deepEqual(t.pushes(), []);
  });

  it("pushes a rebased branch over the head it fetched", async () => {
    const t = await setup({ pushed: true });
    const fetched = t.pusher.remoteHead!;
    commitFile(t.fixture.other, "m.txt", "m\n", "newer main");
    git(t.fixture.other, "push", "--quiet", "origin", "HEAD:main");
    git(t.fixture.workspace, "fetch", "--quiet", "origin", "main");
    git(t.fixture.workspace, "rebase", "--quiet", "origin/main");
    await t.pusher.flush();
    const head = git(t.fixture.workspace, "rev-parse", "HEAD");
    assert.equal(t.fixture.remoteHead(branch), head);
    assert.notEqual(head, fetched);
  });

  it("stops on a moved remote and never overwrites it", async () => {
    const t = await setup({ pushed: true });
    const theirs = commitFile(t.fixture.other, "t.txt", "t\n", "someone else");
    git(t.fixture.other, "push", "--quiet", "origin", branch);
    commit(t.fixture, "mine.txt");
    const error = await rejection(t.pusher.flush());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_PUSH_REJECTED");
    assert.match(error.message, /is no longer at [0-9a-f]{40}/);
    assert.equal(t.fixture.remoteHead(branch), theirs);
    commit(t.fixture, "later.txt");
    await t.pusher.request();
    assert.equal(t.pushes().length, 1);
    assert.equal(await rejection(t.pusher.flush()), error);
  });

  it("rejects a branch that appeared after the empty lease", async () => {
    const t = await setup();
    git(t.fixture.other, "checkout", "--quiet", "-b", branch);
    commitFile(t.fixture.other, "o.txt", "o\n", "racing push");
    git(t.fixture.other, "push", "--quiet", "origin", branch);
    commit(t.fixture, "a.txt");
    const error = await rejection(t.pusher.flush());
    assert.match((error as Error).message, /is no longer at absent/);
  });

  for (const [name, stderr, pattern, code] of [
    [
      "a missing workflows permission",
      " ! [remote rejected] x -> x (refusing to allow a GitHub App to create or " +
        "update workflow `.github/workflows/ci.yml` without `workflows` permission)",
      /lacks the workflows permission/,
      "STAGE_PUSH_REJECTED",
    ],
    [
      "a missing workflow scope",
      "refusing to allow an OAuth App to create or update workflow " +
        "without `workflow` scope",
      /lacks the workflows permission/,
      "STAGE_PUSH_REJECTED",
    ],
    [
      "another rejection",
      " ! [remote rejected] x -> x (protected branch hook declined)",
      /GitHub rejected the push/,
      "STAGE_PUSH_REJECTED",
    ],
    [
      "a transport failure",
      "fatal: unable to access",
      /git push failed/,
      "STAGE_GIT_FAILED",
    ],
  ] as const) {
    it(`reports ${name}`, async () => {
      const t = await setup({
        override: (call) =>
          isPush(call)
            ? { exitCode: 1, stdout: "", stderr: `${stderr} ${fakeToken}` }
            : undefined,
      });
      commit(t.fixture, "a.txt");
      const error = await rejection(t.pusher.flush());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(fakeToken));
    });
  }

  it("stops pushing once the Issue is no longer eligible", async () => {
    let checks = 0;
    const t = await setup({
      beforePush: () => {
        checks += 1;
        return Promise.resolve(false);
      },
    });
    commit(t.fixture, "a.txt");
    await t.pusher.flush();
    assert.equal(t.pusher.halted, true);
    commit(t.fixture, "b.txt");
    await t.pusher.flush();
    assert.deepEqual(t.pushes(), []);
    assert.equal(checks, 1);
  });

  it("keeps a failure of the eligibility check as an error", async () => {
    const t = await setup({
      // A check may fail with any value; the pusher must still report an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      beforePush: () => Promise.reject("odd"),
    });
    commit(t.fixture, "a.txt");
    const error = await rejection(t.pusher.flush());
    assert.ok(error instanceof Error);
    assert.equal(error.message, "odd");
  });

  it("collapses requests during a push into one follow-up push", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const inCheck = new Promise<void>((resolve) => (entered = resolve));
    let first = true;
    const t = await setup({
      beforePush: () => {
        if (!first) {
          return Promise.resolve(true);
        }
        first = false;
        entered!();
        return new Promise((resolve) => (release = () => resolve(true)));
      },
    });
    commit(t.fixture, "a.txt");
    const running = t.pusher.request();
    await inCheck;
    commit(t.fixture, "b.txt");
    const second = commit(t.fixture, "c.txt");
    const more = [t.pusher.request(), t.pusher.request(), t.pusher.request()];
    release!();
    await Promise.all([running, ...more]);
    assert.equal(t.pushes().length, 2);
    assert.equal(t.fixture.remoteHead(branch), second);
  });
});

/** Writes `path` (and its directories) in `cwd` and stages it. */
function put(cwd: string, path: string, text = `${path}\n`) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
  git(cwd, "add", path);
}

function symlink(cwd: string, path: string, target: string) {
  symlinkSync(target, join(cwd, path));
  git(cwd, "add", path);
}

/** Stages the change, commits it and returns the commit. */
function change(fixture: GitFixture, apply: (cwd: string) => void): string {
  apply(fixture.workspace);
  git(fixture.workspace, "commit", "--quiet", "-m", "change");
  return git(fixture.workspace, "rev-parse", "HEAD");
}

const skill: NibfinConfig = {
  tools: {},
  skills: { deliver: { path: "docs/deliver.md", mode: "extend" } },
};

const protectedBase = (other: string) => {
  put(other, ".github/workflows/ci.yml");
  put(other, "docs/deliver.md");
  git(other, "commit", "--quiet", "-m", "protected files");
};

describe("BranchPusher on protected paths", () => {
  for (const [name, apply, listed] of [
    ["adds", (cwd: string) => put(cwd, ".nibfin/policy.json"), ".nibfin/policy.json"],
    [
      "modifies",
      (cwd: string) => put(cwd, ".github/workflows/ci.yml", "x\n"),
      ".github/workflows/ci.yml",
    ],
    [
      "deletes",
      (cwd: string) => git(cwd, "rm", "--quiet", "docs/deliver.md"),
      "docs/deliver.md",
    ],
    [
      "renames away",
      (cwd: string) => git(cwd, "mv", "docs/deliver.md", "src.md"),
      "docs/deliver.md",
    ],
  ] as const) {
    it(`refuses a head that ${name} a protected file`, async () => {
      const t = await setup({ base: protectedBase, config: skill });
      const clean = commit(t.fixture, "a.txt");
      await t.pusher.flush();
      change(t.fixture, apply);
      const error = await rejection(t.pusher.flush());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_PROTECTED_PATH");
      assert.match(error.message, new RegExp(`Changed on the branch: .*\\n- ${listed}$`));
      assert.match(error.message, /separately authorized maintenance route/);
      assert.equal(t.pushes().length, 1);
      assert.equal(t.fixture.remoteHead(branch), clean);
      // No later push happens in that run.
      commit(t.fixture, "b.txt");
      await t.pusher.request();
      assert.equal(t.pushes().length, 1);
    });
  }

  it("refuses a head that retargets a parent symlink of a skill", async () => {
    const t = await setup({
      base: (other) => {
        put(other, "guides/deliver.md");
        symlink(other, "docs", "guides");
        git(other, "commit", "--quiet", "-m", "linked skill");
      },
      config: skill,
    });
    change(t.fixture, (cwd) => {
      put(cwd, "evil/deliver.md");
      unlinkSync(join(cwd, "docs"));
      symlink(cwd, "docs", "evil");
    });
    const error = await rejection(t.pusher.flush());
    assert.equal((error as StageError).code, "STAGE_PROTECTED_PATH");
    assert.match((error as Error).message, /\n- docs$/);
    assert.deepEqual(t.pushes(), []);
  });

  it("refuses a head that adds a parent symlink of a missing skill", async () => {
    const t = await setup({ config: skill });
    change(t.fixture, (cwd) => {
      put(cwd, "evil/deliver.md");
      symlink(cwd, "docs", "evil");
    });
    const error = await rejection(t.pusher.flush());
    assert.match((error as Error).message, /\n- docs$/);
    assert.deepEqual(t.pushes(), []);
  });

  it("refuses a head that edits the target of a .rulesync symlink", async () => {
    const t = await setup({
      base: (other) => {
        put(other, "config/rules/a.md");
        symlink(other, ".rulesync", "config/rules");
        git(other, "commit", "--quiet", "-m", "linked rules");
      },
    });
    change(t.fixture, (cwd) => put(cwd, "config/rules/a.md", "evil\n"));
    const error = await rejection(t.pusher.flush());
    assert.match((error as Error).message, /\n- config\/rules\/a\.md$/);
    assert.deepEqual(t.pushes(), []);
  });

  it("refuses a branch that is behind the base on a protected path", async () => {
    const t = await setup({
      config: skill,
      base: (other) => {
        git(other, "checkout", "--quiet", "-b", branch);
        commitFile(other, "o.txt", "o\n", "earlier work");
        git(other, "push", "--quiet", "origin", branch);
        git(other, "checkout", "--quiet", "main");
        put(other, "docs/deliver.md", "new\n");
        git(other, "commit", "--quiet", "-m", "newer skill");
      },
    });
    const fetched = t.pusher.remoteHead;
    commit(t.fixture, "a.txt");
    const error = await rejection(t.pusher.flush());
    assert.match(
      (error as Error).message,
      /Only behind the base: .*rebased onto origin\/main.*\n- docs\/deliver\.md$/,
    );
    assert.doesNotMatch((error as Error).message, /Changed on the branch/);
    assert.deepEqual(t.pushes(), []);
    assert.equal(t.fixture.remoteHead(branch), fetched);
  });
});
