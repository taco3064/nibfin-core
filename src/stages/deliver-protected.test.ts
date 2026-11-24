import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { NibfinConfig } from "../config/index.ts";
import { rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  failedActionsCheck,
} from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import { agentResult, type AgentStep } from "./fake-job.test.ts";

const done = agentResult({ outcome: "done" });
const pass = agentResult({ outcome: "pass" });
const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];

const config: NibfinConfig = {
  tools: {},
  skills: { deliver: { path: "docs/deliver.md", mode: "extend" } },
};

function pushes(world: DeliveryWorld) {
  return world.git.calls.filter((call) => call.args.includes("push"));
}

function put(cwd: string, path: string, text = `${path}\n`) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
  git(cwd, "add", path);
}

function symlink(cwd: string, path: string, target: string) {
  symlinkSync(target, join(cwd, path));
  git(cwd, "add", path);
}

/** A Writer that applies `change` in the workspace and commits it. */
function writer(apply: (workspace: string) => void): AgentStep {
  return (options) => {
    apply(options.workspace);
    git(options.workspace, "commit", "--quiet", "-m", "feat: change");
    return done;
  };
}

/** Commits to `main` in the other clone, pushes it and updates the workspace. */
function advanceBase(world: DeliveryWorld, apply: (other: string) => void) {
  const { other, workspace } = world.fixture;
  git(other, "checkout", "--quiet", "main");
  apply(other);
  git(other, "commit", "--quiet", "-m", "base change");
  git(other, "push", "--quiet", "origin", "main");
  git(workspace, "pull", "--quiet", "origin", "main");
}

/** Pushes the Issue branch from the current `main` with one commit and opens PR #7. */
function openPull(world: DeliveryWorld): string {
  const { other } = world.fixture;
  git(other, "checkout", "--quiet", "-b", branch);
  const head = commitFile(other, "a.txt", "a\n", "feat: a");
  git(other, "push", "--quiet", "origin", branch);
  world.pulls.push({
    number: 7,
    state: "open",
    merged: false,
    head: branch,
    sha: head,
    mergeSha: null,
  });
  world.required.push("verify");
  world.checkRuns.set(head, [failedActionsCheck(55, "verify")]);
  return head;
}

const linkedSkill = (other: string) => {
  put(other, "guides/deliver.md");
  symlink(other, "docs", "guides");
};

async function assertStopped(world: DeliveryWorld, listed: RegExp) {
  const error = await rejection(world.run());
  assert.ok(error instanceof StageError);
  assert.equal(error.code, "STAGE_PROTECTED_PATH");
  assert.match(error.message, listed);
  // No Acceptor ran and no PR exists.
  assert.deepEqual(
    world.agent.runs.map((run) => roleOf(run.prompt)),
    ["Writer"],
  );
  return error;
}

describe("runDeliverStage on an open PR with protected paths", () => {
  it("stops before the Acceptor on a Writer commit to a protected path", async () => {
    const world = await deliveryWorld({
      reason: "ci-failure",
      config,
      steps: [writer((cwd) => put(cwd, ".github/workflows/ci.yml")), pass],
    });
    const head = openPull(world);
    await assertStopped(
      world,
      /Changed on the branch: .*\n- \.github\/workflows\/ci\.yml$/,
    );
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), head);
  });

  it("stops on a commit that retargets a parent symlink of a skill", async () => {
    const world = await deliveryWorld({
      reason: "ci-failure",
      config,
      steps: [
        writer((cwd) => {
          put(cwd, "evil/deliver.md");
          unlinkSync(join(cwd, "docs"));
          symlink(cwd, "docs", "evil");
        }),
        pass,
      ],
    });
    advanceBase(world, linkedSkill);
    const head = openPull(world);
    await assertStopped(world, /\n- docs$/);
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), head);
  });

  it("stops on a PR branch behind the base on a skill file", async () => {
    const world = await deliveryWorld({
      reason: "ci-failure",
      config,
      steps: [writer((cwd) => put(cwd, "fix.txt")), pass],
    });
    advanceBase(world, (other) => put(other, "docs/deliver.md", "old\n"));
    const head = openPull(world);
    advanceBase(world, (other) => put(other, "docs/deliver.md", "new\n"));
    const error = await assertStopped(
      world,
      /Only behind the base: .*\(rebased onto origin\/main\).*\n- docs\/deliver\.md$/,
    );
    assert.doesNotMatch(error.message, /Changed on the branch/);
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), head);
  });
});

describe("runDeliverStage on a new branch with protected paths", () => {
  for (const [name, apply, listed] of [
    [
      "a protected file",
      (cwd: string) => put(cwd, ".nibfin.json", "{}\n"),
      /\n- \.nibfin\.json$/,
    ],
    [
      "a parent symlink of a missing skill",
      (cwd: string) => {
        put(cwd, "evil/deliver.md");
        symlink(cwd, "docs", "evil");
      },
      /\n- docs$/,
    ],
  ] as const) {
    it(`never pushes a head that adds ${name}`, async () => {
      const world = await deliveryWorld({ config, steps: [writer(apply), pass] });
      await assertStopped(world, listed);
      assert.deepEqual(pushes(world), []);
      assert.equal(world.fixture.remoteHead(branch), undefined);
    });
  }

  it("stops before the Acceptor on an ignored file under .rulesync/", async () => {
    const world = await deliveryWorld({
      config,
      steps: [
        writer((cwd) => {
          put(cwd, "a.txt");
          const exclude = join(cwd, ".git", "info", "exclude");
          appendFileSync(exclude, "\n/.rulesync/\n");
          mkdirSync(join(cwd, ".rulesync"));
          writeFileSync(join(cwd, ".rulesync", "rules.md"), "evil\n");
        }),
        pass,
      ],
    });
    await assertStopped(world, /Changed on the branch: .*\n- \.rulesync\/rules\.md$/);
    // The commit itself was clean and was saved.
    assert.equal(
      world.fixture.remoteHead(branch),
      git(world.fixture.workspace, "rev-parse", "HEAD"),
    );
    assert.equal(world.pulls.length, 0);
  });
});
