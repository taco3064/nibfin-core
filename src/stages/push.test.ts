import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
import { BranchPusher } from "./push.ts";

const branch = "nibfin/issue-1";
const isPush = (call: GitCall) => call.args.includes("push");

async function setup(
  options: {
    pushed?: boolean;
    override?: (call: GitCall) => GitOutput | undefined;
    beforePush?: () => Promise<boolean>;
  } = {},
) {
  const fixture = await makeGitFixture("push-");
  if (options.pushed) {
    git(fixture.other, "checkout", "--quiet", "-b", branch);
    commitFile(fixture.other, "o.txt", "o\n", "earlier work");
    git(fixture.other, "push", "--quiet", "origin", branch);
  }
  const recorder = recordingGit(options.override);
  const subject = fixtureGit(fixture, recorder.run);
  const prepared = await prepareBranch(subject, {
    base: "main",
    branch,
    actor: fakeActor,
  });
  const logs: string[] = [];
  const pusher = new BranchPusher({
    git: subject,
    branch,
    remoteHead: prepared.remoteHead,
    beforePush: options.beforePush ?? (() => Promise.resolve(true)),
    log: (line) => logs.push(line),
  });
  const pushes = () => recorder.calls.filter(isPush);
  return { fixture, recorder, pusher, logs, pushes };
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
    for (const call of t.recorder.calls) {
      assert.ok(!call.args.join(" ").includes(fakeToken));
    }
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
