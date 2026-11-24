import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentError } from "../agent/index.ts";
import { fakeToken, rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  shapeText,
} from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import { agentResult, type AgentStep, seedComment } from "./fake-job.test.ts";

const done = agentResult({ outcome: "done" });
const pass = agentResult({ outcome: "pass" });
const basic = Buffer.from(`x-access-token:${fakeToken}`).toString("base64");
const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];
const watched = { timeout: 60_000 };

/** A Writer that commits each file, waiting for Core's push of each when asked. */
function writer(
  world: () => DeliveryWorld,
  files: string[],
  options: { waitForPush?: boolean; result?: string; message?: string } = {},
): AgentStep {
  return async () => {
    const { fixture } = world();
    for (const file of files) {
      const message = options.message ?? `feat: add ${file}`;
      const sha = commitFile(fixture.workspace, file, `${file}\n`, message);
      if (options.waitForPush) {
        await world().waitForLog(new RegExp(`^Pushed ${branch} at ${sha}$`));
      }
    }
    return options.result ?? done;
  };
}

function next(world: DeliveryWorld): unknown {
  return JSON.parse(readFileSync(world.nextFile, "utf8"));
}

function pushes(world: DeliveryWorld) {
  return world.git.calls.filter((call) => call.args.includes("push"));
}

/** No token in any Git argument, agent run, prompt, log, or Git config. */
function assertNoTokenLeak(world: DeliveryWorld) {
  for (const call of world.git.calls) {
    const args = call.args.join(" ");
    assert.ok(!args.includes(fakeToken) && !args.includes(basic), args);
    // Only calls to the remote carry the header, and never from the workspace.
    const remote = call.args.includes(world.fixture.remote);
    assert.equal(call.env.GIT_CONFIG_COUNT !== undefined, remote, args);
    if (remote) {
      assert.notEqual(call.cwd, world.fixture.workspace);
    }
  }
  // Core's push repository is removed when the run ends.
  assert.deepEqual(
    readdirSync(world.fixture.root).filter((name) => name.startsWith("nibfin-push-")),
    [],
  );
  for (const run of world.agent.runs) {
    const text = JSON.stringify(run);
    assert.ok(!text.includes(fakeToken) && !text.includes(basic));
  }
  for (const line of world.agent.logs) {
    assert.ok(!line.includes(fakeToken) && !line.includes(basic));
  }
  for (const dir of [join(world.fixture.workspace, ".git"), world.fixture.remote]) {
    const config = readFileSync(join(dir, "config"), "utf8");
    assert.ok(!config.includes(fakeToken) && !config.includes(basic));
  }
  for (const output of world.git.outputs) {
    assert.ok(!output.stdout.includes(basic) && !output.stderr.includes(basic));
  }
}

describe("runDeliverStage eligibility", () => {
  for (const [name, issue, expected] of [
    ["unshaped", { labels: ["scope"] }, "shape (no reason)"],
    [
      "paused",
      { labels: ["scope", "shaped", "pause"] },
      "ineligible (paused) (no reason)",
    ],
  ] as const) {
    it(`does nothing for an ${name} Issue`, async () => {
      const world = await deliveryWorld({ issue: { labels: [...issue.labels] } });
      assert.equal(await world.run(), 0);
      assert.deepEqual(world.agent.logs, [
        `acme/app#1 is not at the deliver stage: ${expected}`,
      ]);
      assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
      assert.deepEqual(world.agent.runs, []);
      assert.deepEqual(world.git.calls, []);
      assert.deepEqual(world.issues.github.writes(), []);
    });
  }

  it("stays Pending while another Writer of the Issue runs", async () => {
    const world = await deliveryWorld();
    world.runnerRuns.push({
      id: 5,
      status: "in_progress",
      name: "Nibfin",
      display_title: "Nibfin · acme/app#1 · deliver",
      html_url: "https://github.com/acme/runner/actions/runs/5",
    });
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_WRITER_ACTIVE");
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
    assert.deepEqual(world.agent.runs, []);
    assert.deepEqual(world.agent.configReads, []);
    assert.deepEqual(world.git.calls, []);
    assert.deepEqual(world.issues.github.writes(), []);
  });

  it("rejects a workspace that has no base branch checked out", async () => {
    const world = await deliveryWorld();
    git(world.fixture.workspace, "checkout", "--quiet", "-b", branch);
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_INPUT_INVALID");
    assert.deepEqual(world.agent.runs, []);
  });
});

describe("runDeliverStage on a new branch", () => {
  it(
    "saves each commit as it appears, passes Accept and opens the PR",
    watched,
    async () => {
      const get = () => world;
      const world = await deliveryWorld({
        steps: [
          writer(get, ["a.txt", "b.txt", "c.txt"], { waitForPush: true }),
          (options) => {
            assert.equal(git(options.workspace, "status", "--porcelain"), "");
            return pass;
          },
        ],
      });
      assert.equal(await world.run(), 0);
      const head = git(world.fixture.workspace, "rev-parse", "HEAD");
      assert.equal(world.fixture.remoteHead(branch), head);
      assert.equal(pushes(world).length, 3);
      assert.ok(
        pushes(world)[0].args.includes(`--force-with-lease=refs/heads/${branch}:`),
      );
      const [pull] = world.pulls;
      assert.deepEqual(
        { title: pull.title, body: pull.body, base: pull.base, head: pull.head },
        { title: "Add the widget (#1)", body: "Part of #1", base: "main", head: branch },
      );
      assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
      const [writerRun, acceptorRun] = world.agent.runs;
      assert.equal(roleOf(writerRun.prompt), "Writer");
      assert.equal(roleOf(acceptorRun.prompt), "Accept sub agent");
      assert.match(writerRun.prompt, /^SKILL TEXT OF deliver/);
      assert.match(acceptorRun.prompt, /^SKILL TEXT OF accept/);
      for (const run of [writerRun, acceptorRun]) {
        assert.ok(run.prompt.includes(shapeText));
        assert.match(run.prompt, /The widget must exist\./);
      }
      assert.match(writerRun.prompt, /Work on branch `nibfin\/issue-1`/);
      assert.match(writerRun.prompt, /pushes each new commit as it appears/);
      assert.match(
        acceptorRun.prompt,
        /## Branch diff against origin\/main\n\n```diff\n/,
      );
      assert.match(acceptorRun.prompt, /\+\+\+ b\/c\.txt/);
      assert.doesNotMatch(acceptorRun.prompt, /Fix reason/);
      assert.deepEqual(world.agent.logs.slice(0, 1), ["Round 1: Writer"]);
      assert.match(world.agent.logs.at(-1)!, /^Pull request: https:/);
      assertNoTokenLeak(world);
    },
  );

  it("saves progress by the final push with the reftable ref backend", async () => {
    const world = await deliveryWorld({
      steps: [writer(() => world, ["a.txt", "b.txt"]), pass],
      override: (call) =>
        call.args.includes("--show-ref-format")
          ? { exitCode: 0, stdout: "reftable\n", stderr: "" }
          : undefined,
    });
    assert.equal(await world.run(), 0);
    assert.equal(pushes(world).length, 1);
    assert.ok(world.agent.logs.some((line) => /reftable ref backend/.test(line)));
    assert.equal(world.pulls.length, 1);
  });

  it("returns a closing keyword to the Writer as a defect", async () => {
    const reword: AgentStep = (options) => {
      git(options.workspace, "commit", "--quiet", "--amend", "-m", "feat: add a");
      return done;
    };
    const world = await deliveryWorld({
      steps: [
        writer(() => world, ["a.txt"], { message: "feat: add a\n\nCloses #1" }),
        reword,
        pass,
      ],
    });
    assert.equal(await world.run(), 0);
    const [, second, acceptor] = world.agent.runs;
    assert.match(
      second.prompt,
      /## Defects\n\n- Commit messages ahead of main contain a closing/,
    );
    assert.equal(roleOf(acceptor.prompt), "Accept sub agent");
    assert.equal(world.agent.runs.length, 3);
    assert.doesNotMatch(
      git(world.fixture.remote, "log", "--format=%B", branch),
      /Closes/,
    );
  });

  it("sends Accept defects to the Writer, then asks a fresh Acceptor", async () => {
    const defects = agentResult({ outcome: "defects", defects: ["Missing test for b"] });
    const world = await deliveryWorld({
      steps: [
        writer(() => world, ["a.txt"]),
        defects,
        writer(() => world, ["b.test.txt"]),
        pass,
      ],
    });
    assert.equal(await world.run(), 0);
    const [, , fix, second] = world.agent.runs;
    assert.match(fix.prompt, /Fix every defect below/);
    assert.match(fix.prompt, /- Missing test for b/);
    assert.match(second.prompt, /\+\+\+ b\/b\.test\.txt/);
    assert.doesNotMatch(second.prompt, /Missing test for b/);
    assert.ok(world.agent.logs.includes("Round 1: defects\n- Missing test for b"));
    assert.ok(world.agent.logs.includes("Round 2: Accept sub agent"));
  });

  it("resolves an earlier blocked report after the PR", async () => {
    const world = await deliveryWorld({ steps: [writer(() => world, ["a.txt"]), pass] });
    const issue = world.issues.main;
    seedComment(world.issues, issue, "<!-- nibfin:deliver-blocked -->\nold");
    assert.equal(await world.run(), 0);
    assert.match(world.issues.marked("deliver-blocked")[0].body, /Resolved: /);
  });

  it("leaves the next action empty while CI is required", async () => {
    const world = await deliveryWorld({ steps: [writer(() => world, ["a.txt"]), pass] });
    world.required.push("verify");
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: true });
  });
});

describe("runDeliverStage on a pushed branch", () => {
  it("continues from the pushed head and leases it", watched, async () => {
    const world = await deliveryWorld({
      steps: [writer(() => world, ["b.txt", "c.txt"], { waitForPush: true }), pass],
    });
    const { other } = world.fixture;
    git(other, "checkout", "--quiet", "-b", branch);
    const earlier = commitFile(other, "a.txt", "a\n", "feat: earlier work");
    git(other, "push", "--quiet", "origin", branch);
    world.pulls.push({
      number: 3,
      state: "closed",
      merged: false,
      head: branch,
      sha: earlier,
      mergeSha: null,
    });
    assert.equal(await world.run(), 0);
    const [first] = pushes(world);
    assert.ok(first.args.includes(`--force-with-lease=refs/heads/${branch}:${earlier}`));
    assert.equal(pushes(world).length, 2);
    assert.equal(git(world.fixture.remote, "rev-list", "--count", branch), "4");
    assert.equal(world.pulls.length, 2);
  });

  it("stops without overwriting a branch someone else moved", async () => {
    const racing: AgentStep = async () => {
      const { other } = world.fixture;
      git(other, "fetch", "--quiet", "origin");
      git(other, "checkout", "--quiet", "-b", branch, `origin/${branch}`);
      commitFile(other, "z.txt", "z\n", "someone else");
      git(other, "push", "--quiet", "origin", branch);
      commitFile(world.fixture.workspace, "b.txt", "b\n", "feat: b");
      return Promise.resolve(done);
    };
    const world = await deliveryWorld({
      steps: [racing],
      override: (call) =>
        call.args.includes("--show-ref-format")
          ? { exitCode: 0, stdout: "reftable\n", stderr: "" }
          : undefined,
    });
    const { other } = world.fixture;
    git(other, "checkout", "--quiet", "-b", "seed");
    commitFile(other, "a.txt", "a\n", "feat: a");
    git(other, "push", "--quiet", "origin", `seed:${branch}`);
    git(other, "checkout", "--quiet", "main");
    const theirs = () => git(world.fixture.remote, "log", "-1", "--format=%s", branch);
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_PUSH_REJECTED");
    assert.equal(theirs(), "someone else");
    assert.equal(world.pulls.length, 0);
    assertNoTokenLeak(world);
  });
});

describe("runDeliverStage stops", () => {
  it("reports a blocked Writer after saving its partial work", async () => {
    const blocked = agentResult({ outcome: "blocked", reason: "The API is missing" });
    const world = await deliveryWorld({
      steps: [writer(() => world, ["a.txt"], { result: blocked })],
    });
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.match((error as StageError).message, /^Writer returned blocked \(https:/);
    const head = git(world.fixture.workspace, "rev-parse", "HEAD");
    assert.equal(world.fixture.remoteHead(branch), head);
    const [comment] = world.issues.marked("deliver-blocked");
    assert.match(
      comment.body,
      /The delivery is blocked \(Writer\)\.\n\nThe API is missing/,
    );
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: true });
    assert.equal(world.pulls.length, 0);
  });

  it("reports a blocked Acceptor", async () => {
    const blocked = agentResult({
      outcome: "blocked",
      reason: "Shape contradicts Issue",
    });
    const world = await deliveryWorld({
      steps: [writer(() => world, ["a.txt"]), blocked],
    });
    const error = await rejection(world.run());
    assert.match((error as StageError).message, /^Accept sub agent returned blocked/);
    assert.equal(world.pulls.length, 0);
  });

  it("blocks without an approved Shape comment", async () => {
    const world = await deliveryWorld({ noShape: true });
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.match(world.issues.marked("deliver-blocked")[0].body, /no approved Shape/);
    assert.deepEqual(world.agent.runs, []);
  });

  for (const [name, step, code, pattern] of [
    [
      "uncommitted changes",
      (workspace: string) => writeFileSync(join(workspace, "left.txt"), "x"),
      "STAGE_WORKSPACE_MODIFIED",
      /uncommitted changes:\n\?\? left\.txt/,
    ],
    ["no commits", () => undefined, "STAGE_RESULT_INVALID", /without commits ahead/],
    [
      "another branch checked out",
      (workspace: string) => git(workspace, "checkout", "--quiet", "main"),
      "STAGE_WORKSPACE_MODIFIED",
      /off nibfin\/issue-1/,
    ],
  ] as const) {
    it(`rejects a Writer that leaves ${name}`, async () => {
      const world = await deliveryWorld({
        steps: [
          (options) => {
            step(options.workspace);
            return done;
          },
        ],
      });
      const error = await rejection(world.run());
      assert.equal((error as StageError).code, code);
      assert.match((error as StageError).message, pattern);
      // Nothing is ahead of the base, so nothing was pushed.
      assert.deepEqual(pushes(world), []);
      assert.equal(world.fixture.remoteHead(branch), undefined);
    });
  }

  it("pushes nothing for a blocked Writer without commits", async () => {
    const blocked = agentResult({ outcome: "blocked", reason: "No access" });
    const world = await deliveryWorld({ steps: [blocked] });
    const error = await rejection(world.run());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), undefined);
    assertNoTokenLeak(world);
  });

  it("stops without pushing once the Issue is paused", async () => {
    const pausing: AgentStep = () => {
      world.issues.main.labels.push("pause");
      commitFile(world.fixture.workspace, "a.txt", "a\n", "feat: a");
      return done;
    };
    const world = await deliveryWorld({ steps: [pausing] });
    assert.equal(await world.run(), 0);
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), undefined);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
    assert.ok(
      world.agent.logs.some((line) =>
        /no longer eligible \(ineligible \(paused/.test(line),
      ),
    );
  });

  it("stops without pushing once the Issue moved to another branch", async () => {
    const moving: AgentStep = () => {
      const { other } = world.fixture;
      git(other, "push", "--quiet", "origin", `main:${branch}-cd-1`);
      commitFile(world.fixture.workspace, "a.txt", "a\n", "feat: a");
      return done;
    };
    const world = await deliveryWorld({ steps: [moving] });
    assert.equal(await world.run(), 0);
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), undefined);
    assert.ok(
      world.agent.logs.includes(
        "The Issue is no longer eligible (on nibfin/issue-1-cd-1); " +
          "stopping without writing",
      ),
    );
  });

  it("gives an Issue without a description as such", async () => {
    const world = await deliveryWorld({
      issue: { body: null },
      steps: [new Error("stop")],
    });
    await rejection(world.run());
    assert.match(
      world.agent.runs[0].prompt,
      /Title: Add the widget\n\n\(no description\)/,
    );
  });

  it("stops before the PR when the Issue was paused after Accept", async () => {
    const pausing: AgentStep = () => {
      world.issues.main.labels.push("pause");
      return pass;
    };
    const world = await deliveryWorld({
      steps: [writer(() => world, ["a.txt"]), pausing],
    });
    assert.equal(await world.run(), 0);
    assert.equal(world.pulls.length, 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: true });
  });

  it("saves the Writer's work when its run fails, then fails", async () => {
    const failing: AgentStep = () => {
      commitFile(world.fixture.workspace, "a.txt", "a\n", "feat: a");
      throw new AgentError("AGENT_RUN_FAILED", "Claude Code failed", { exitCode: 1 });
    };
    const world = await deliveryWorld({ steps: [failing] });
    const error = await rejection(world.run());
    assert.ok(error instanceof AgentError);
    assert.equal(
      world.fixture.remoteHead(branch),
      git(world.fixture.workspace, "rev-parse", "HEAD"),
    );
  });
});
