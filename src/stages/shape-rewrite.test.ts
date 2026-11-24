import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { rejection } from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import { StageError } from "./errors.ts";
import { branch, deliveryWorld } from "./fake-delivery.test.ts";
import {
  agentResult,
  type AgentStep,
  commentVersion,
  fakeDeps,
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  jobContext,
  makeCommittedWorkspace,
  seedComment,
} from "./fake-job.test.ts";
import { runShapeStage } from "./shape.ts";
import { shapeWrongBody } from "./shape-wrong.ts";

let workspace: string;
before(async () => {
  workspace = await makeCommittedWorkspace("shape-rewrite-");
});

const shapeMarker = "<!-- nibfin:shape -->";
const wrongMarker = "<!-- nibfin:shape-wrong -->";
const reason = "Step 2 drops the CLI flag that the Issue requires.";
const ready = (shape: string) => agentResult({ outcome: "ready", shape });
const approved = agentResult({ outcome: "approved" });
const changes = (...findings: string[]) =>
  agentResult({ outcome: "changes-required", findings });
const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];
const resolvedTitle = "Resolved: a rewritten Shape was approved and written.";

async function setup(steps: AgentStep[], main: FakeIssue = fakeIssue()) {
  const issues = fakeIssues(main);
  const fake = fakeDeps(steps);
  const nextFile = join(await makeTempDir("shape-next-"), "next.json");
  const context = { ...jobContext(workspace), nextFile };
  const shape = seedComment(issues, main, `${shapeMarker}\nOld plan`);
  const report = (body: string) => seedComment(issues, main, `${wrongMarker}\n${body}`);
  return {
    issues,
    fake,
    shape,
    report,
    run: () => runShapeStage(context, issues.github.client, fake.deps),
    next: () => JSON.parse(readFileSync(nextFile, "utf8")) as unknown,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function resolvedBody(version: string, reported: string) {
  return (
    `${resolvedTitle}\nRewritten as Shape version: ${version}\n\n` +
    shapeWrongBody(reported, reason)
  );
}

function writeOrder(t: Setup) {
  return t.issues.github.writes().map((call) => `${call.method} ${call.path}`);
}

describe("runShapeStage rewrite of a Shape reported wrong", () => {
  it("rewrites from the reason, resolves it, then adds shaped", async () => {
    const author: AgentStep = (options) => {
      assert.equal(roleOf(options.prompt), "Shape Author");
      assert.match(options.prompt, /## Task\n\nRewrite the Shape: the previous one was/);
      assert.match(options.prompt, /## Previous Shape\n\nOld plan/);
      assert.match(
        options.prompt,
        new RegExp(`## Why the previous Shape is wrong\n\n${reason}`),
      );
      return `Author notes.\n${ready("New plan")}`;
    };
    const validator: AgentStep = (options) => {
      assert.equal(roleOf(options.prompt), "Shape Validator");
      assert.match(options.prompt, /resolves why the previous Shape was found wrong/);
      assert.match(options.prompt, /## Proposed Shape\n\nNew plan/);
      assert.match(
        options.prompt,
        new RegExp(`## Why the previous Shape is wrong\n\n${reason}$`, "m"),
      );
      assert.doesNotMatch(options.prompt, /Author notes|Previous Shape\n\nOld plan/);
      return approved;
    };
    const t = await setup([author, validator]);
    const old = commentVersion(t.shape);
    const report = t.report(shapeWrongBody(old, reason));
    assert.equal(await t.run(), 0);
    assert.equal(t.shape.body, `${shapeMarker}\nNew plan`);
    assert.notEqual(commentVersion(t.shape), old);
    assert.equal(
      report.body,
      `${wrongMarker}\n${resolvedBody(commentVersion(t.shape), old)}`,
    );
    assert.deepEqual(t.issues.main.labels, ["scope", "shaped"]);
    assert.deepEqual(writeOrder(t), [
      `PATCH /repos/acme/app/issues/comments/${t.shape.id}`,
      `PATCH /repos/acme/app/issues/comments/${report.id}`,
      "POST /repos/acme/app/issues/1/labels",
    ]);
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: true });
  });

  it("keeps the reason through every changes-required round", async () => {
    const t = await setup([
      ready("v1"),
      changes("Name the flag"),
      ready("v2"),
      changes("Name the default"),
      ready("v3"),
      approved,
    ]);
    t.report(shapeWrongBody(commentVersion(t.shape), reason));
    assert.equal(await t.run(), 0);
    const prompts = t.fake.runs.map((run) => run.prompt);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(`## Why the previous Shape is wrong\n\n${reason}`));
    }
    assert.match(prompts[2], /## Task\n\nRevise the previous proposed Shape/);
    assert.match(prompts[2], /## Previous proposed Shape\n\nv1/);
    assert.doesNotMatch(prompts[2], /## Previous Shape\n/);
    assert.match(prompts[3], /## Previous proposed Shape\n\nv1/);
    assert.match(prompts[3], /## Previous Validator findings\n\n- Name the flag/);
    assert.equal(t.shape.body, `${shapeMarker}\nv3`);
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: true });
  });

  it("resolves a rewrite whose text is unchanged, keeping the version", async () => {
    const t = await setup([ready("Old plan"), approved]);
    const version = commentVersion(t.shape);
    const report = t.report(shapeWrongBody(version, reason));
    assert.equal(await t.run(), 0);
    assert.equal(commentVersion(t.shape), version);
    assert.equal(report.body, `${wrongMarker}\n${resolvedBody(version, version)}`);
    assert.ok(t.issues.main.labels.includes("shaped"));
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: true });
  });

  it("writes no next action and publishes nothing when paused meanwhile", async () => {
    const t = await setup([
      ready("New plan"),
      () => {
        t.issues.main.labels.push("pause");
        return approved;
      },
    ]);
    const report = t.report(shapeWrongBody(commentVersion(t.shape), reason));
    const before = report.body;
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: false });
    assert.equal(t.shape.body, `${shapeMarker}\nOld plan`);
    assert.equal(report.body, before);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("fails unconfirmed when a changed Shape keeps its version", async () => {
    const t = await setup([ready("New plan"), approved]);
    t.report(shapeWrongBody(commentVersion(t.shape), reason));
    const path = `PATCH /repos/acme/app/issues/comments/${t.shape.id}`;
    t.issues.github.routes.set(path, (request) => {
      t.shape.body = (request.body as { body: string }).body;
      return { data: {} };
    });
    const error = await rejection(t.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.match(String(error.cause), /version did not change/);
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
    assert.match(
      t.issues.marked("shape-wrong")[0].body,
      /^<!-- nibfin:shape-wrong -->\nThe/,
    );
    assert.ok(!t.issues.main.labels.includes("shaped"));
  });

  it("writes no next action when a role is blocked", async () => {
    const t = await setup([agentResult({ outcome: "blocked", reason: "Needs Scope." })]);
    t.report(shapeWrongBody(commentVersion(t.shape), reason));
    const error = await rejection(t.run());
    assert.equal((error as StageError).code, "STAGE_BLOCKED");
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
  });
});

describe("runShapeStage redo after a crash during a rewrite", () => {
  it("validates the written rewrite with the reason, then resolves it", async () => {
    const t = await setup([
      (options) => {
        assert.equal(roleOf(options.prompt), "Shape Validator");
        assert.match(options.prompt, /## Proposed Shape\n\nOld plan/);
        assert.ok(
          options.prompt.includes(`## Why the previous Shape is wrong\n\n${reason}`),
        );
        return approved;
      },
    ]);
    const report = t.report(shapeWrongBody("1.1", reason));
    assert.equal(await t.run(), 0);
    assert.equal(
      report.body,
      `${wrongMarker}\n${resolvedBody(commentVersion(t.shape), "1.1")}`,
    );
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: true });
  });

  it("re-validates after the resolve and updates Rewritten as", async () => {
    const t = await setup([
      (options) => {
        assert.match(options.prompt, /already marked resolved by the current Shape/);
        return changes("Say which flag");
      },
      (options) => {
        assert.equal(roleOf(options.prompt), "Shape Author");
        assert.ok(
          options.prompt.includes(`## Why the previous Shape is wrong\n\n${reason}`),
        );
        return ready("Precise plan");
      },
      approved,
    ]);
    const report = t.report(resolvedBody(commentVersion(t.shape), "1.1"));
    assert.equal(await t.run(), 0);
    assert.equal(t.shape.body, `${shapeMarker}\nPrecise plan`);
    assert.equal(
      report.body,
      `${wrongMarker}\n${resolvedBody(commentVersion(t.shape), "1.1")}`,
    );
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: true });
  });

  it("restarts delivery when shaped was already added", async () => {
    const t = await setup([], fakeIssue({ labels: ["scope", "shaped"] }));
    t.report(resolvedBody(commentVersion(t.shape), "1.1"));
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.next(), { stage: "deliver", reason: null, progressed: false });
    assert.deepEqual(t.fake.runs, []);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  for (const [name, labels, body] of [
    ["a report resolved by an older version", ["scope", "shaped"], "old"],
    ["an unresolved report of an older version", ["scope", "shaped"], "stale"],
    ["no report", ["scope", "shaped"], undefined],
    ["a paused Issue", ["scope", "shaped", "pause"], "resolved"],
  ] as const) {
    it(`writes no next action at a delivery stage with ${name}`, async () => {
      const t = await setup([], fakeIssue({ labels: [...labels] }));
      const current = commentVersion(t.shape);
      if (body !== undefined) {
        const text = {
          old: resolvedBody("1.1", "1.1"),
          stale: shapeWrongBody("1.1", reason),
          resolved: resolvedBody(current, "1.1"),
        }[body];
        t.report(text);
      }
      assert.equal(await t.run(), 0);
      assert.deepEqual(t.next(), { stage: null, reason: null, progressed: false });
      assert.deepEqual(t.fake.runs, []);
    });
  }

  it("ignores a malformed report and validates the Shape as a first Shape", async () => {
    const t = await setup([
      (options) => {
        assert.doesNotMatch(options.prompt, /Why the previous Shape/);
        return approved;
      },
    ]);
    t.report("The approved Shape is wrong (Writer).\n\nNo version line.");
    assert.equal(await t.run(), 0);
    assert.ok(t.fake.logs.some((line) => /no valid Shape version line/.test(line)));
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
  });

  it("writes no next action after a first Shape", async () => {
    const t = await setup([approved]);
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
  });
});

describe("runShapeStage rewrite with delivery work on GitHub", () => {
  it("asks for a review of an open pull request after the rewrite", async () => {
    const world = await deliveryWorld({
      issue: { labels: ["scope"] },
      steps: [ready("New plan"), approved],
    });
    world.pulls.push({
      number: 7,
      state: "open",
      merged: false,
      head: branch,
      sha: "a".repeat(40),
      mergeSha: null,
    });
    const shape = world.issues.marked("shape")[0];
    const body = shapeWrongBody(commentVersion(shape), reason);
    seedComment(world.issues, world.issues.main, `${wrongMarker}\n${body}`);
    const client = world.issues.github.client;
    assert.equal(await runShapeStage(world.context, client, world.agent.deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(world.nextFile, "utf8")), {
      stage: "review",
      reason: null,
      progressed: true,
    });
  });

  it("asks Deliver to finish a pending report, which removes shaped", async () => {
    const world = await deliveryWorld();
    const shape = world.issues.marked("shape")[0];
    const body = shapeWrongBody(commentVersion(shape), reason);
    seedComment(world.issues, world.issues.main, `${wrongMarker}\n${body}`);
    const client = world.issues.github.client;
    assert.equal(await runShapeStage(world.context, client, world.agent.deps), 0);
    const next = () => JSON.parse(readFileSync(world.nextFile, "utf8")) as unknown;
    assert.deepEqual(next(), { stage: "deliver", reason: null, progressed: false });
    assert.deepEqual(world.issues.github.writes(), []);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(), { stage: "shape", reason: null, progressed: true });
    assert.deepEqual(world.issues.main.labels, ["scope"]);
    assert.deepEqual(world.agent.runs, []);
  });
});
