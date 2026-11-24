import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fakeActor, rejection } from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import {
  branch,
  type DeliveryWorld,
  deliveryWorld,
  type WorldOptions,
} from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import {
  agentResult,
  type AgentStep,
  editShape,
  seedComment,
  shapeVersion,
} from "./fake-job.test.ts";
import { shapeWrongBody } from "./shape-wrong.ts";

const done = agentResult({ outcome: "done" });
const pass = agentResult({ outcome: "pass" });
const wrongMarker = "<!-- nibfin:shape-wrong -->";
const reason = "Shape step 2 drops the CLI flag that Issue clause 3 requires.";
const shapeWrong = agentResult({ outcome: "shape-wrong", reason });
const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];

function next(world: DeliveryWorld): unknown {
  return JSON.parse(readFileSync(world.nextFile, "utf8"));
}

function pushes(world: DeliveryWorld) {
  return world.git.calls.filter((call) => call.args.includes("push"));
}

function seedReport(world: DeliveryWorld, version: string, body?: string) {
  const text = body ?? shapeWrongBody(version, reason);
  seedComment(world.issues, world.issues.main, `${wrongMarker}\n${text}`);
}

/** A world whose branch is pushed and has open PR #7 at its head. */
async function openPullWorld(options: WorldOptions) {
  const world = await deliveryWorld(options);
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
  return { world, head };
}

function reviewComment(world: DeliveryWorld, head: string, shapeLine: string) {
  const body = `<!-- nibfin:review -->\nReviewed head: ${head}\n${shapeLine}\n\nRename.`;
  world.pullComments.set(7, [{ id: 9, userId: fakeActor.id, body }]);
}

describe("runDeliverStage when the Writer finds the Shape wrong", () => {
  it("saves the work, reports the reason and hands the Issue to Shape", async () => {
    const step: AgentStep = () => {
      commitFile(world.fixture.workspace, "a.txt", "a\n", "feat: partial");
      return shapeWrong;
    };
    const world = await deliveryWorld({ steps: [step] });
    const version = shapeVersion(world.issues);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "shape", reason: null, progressed: true });
    assert.deepEqual(
      world.issues.marked("shape-wrong").map((comment) => comment.body),
      [
        `${wrongMarker}\nThe approved Shape is wrong (Writer).\n` +
          `Shape version: ${version}\n\n${reason}`,
      ],
    );
    assert.deepEqual(world.issues.main.labels, ["scope"]);
    assert.equal(world.agent.runs.length, 1);
    assert.equal(roleOf(world.agent.runs[0].prompt), "Writer");
    assert.match(world.agent.runs[0].prompt, /"outcome": "shape-wrong"/);
    assert.equal(pushes(world).length, 1);
    assert.equal(
      world.fixture.remoteHead(branch),
      git(world.fixture.workspace, "rev-parse", "HEAD"),
    );
    assert.deepEqual(world.pulls, []);
  });

  it("pushes nothing to an open pull request (Accept comes first)", async () => {
    const step: AgentStep = () => {
      commitFile(world.fixture.workspace, "b.txt", "b\n", "fix: partial");
      return shapeWrong;
    };
    const { world, head } = await openPullWorld({ reason: "review", steps: [step] });
    reviewComment(world, head, `Reviewed Shape: ${shapeVersion(world.issues)}`);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "shape", reason: null, progressed: true });
    assert.deepEqual(pushes(world), []);
    assert.equal(world.fixture.remoteHead(branch), head);
    assert.equal(world.issues.marked("shape-wrong").length, 1);
    assert.ok(!world.issues.main.labels.includes("shaped"));
  });

  it("writes nothing when the Issue was paused meanwhile", async () => {
    const step: AgentStep = () => {
      world.issues.main.labels.push("pause");
      return shapeWrong;
    };
    const world = await deliveryWorld({ steps: [step] });
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
    assert.deepEqual(world.issues.marked("shape-wrong"), []);
    assert.deepEqual(world.issues.main.labels, ["scope", "shaped", "pause"]);
  });

  it("asks for a new review when the re-check finds the review stale", async () => {
    const step: AgentStep = () => {
      editShape(world.issues, "An owner edit.");
      return shapeWrong;
    };
    const { world, head } = await openPullWorld({ reason: "review", steps: [step] });
    reviewComment(world, head, `Reviewed Shape: ${shapeVersion(world.issues)}`);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: false });
    assert.deepEqual(world.issues.marked("shape-wrong"), []);
    assert.ok(world.issues.main.labels.includes("shaped"));
  });

  it("stops unconfirmed when shaped reads back after the report", async () => {
    const world = await deliveryWorld({ steps: [shapeWrong] });
    world.issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/shaped", {
      data: [],
    });
    const error = await rejection(world.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(world.issues.marked("shape-wrong").length, 1);
  });
});

describe("runDeliverStage redo of a Shape report", () => {
  for (const [name, options] of [
    ["no reason at deliver", {}],
    ["a ci-failure Job at review", { reason: "ci-failure" }],
  ] as const) {
    it(`removes shaped without a Writer (${name})`, async () => {
      const { world } = await openPullWorld({ ...options });
      if (!("reason" in options)) {
        world.pulls.length = 0;
      }
      seedReport(world, shapeVersion(world.issues));
      assert.equal(await world.run(), 0);
      assert.deepEqual(next(world), { stage: "shape", reason: null, progressed: true });
      assert.deepEqual(world.issues.main.labels, ["scope"]);
      assert.deepEqual(world.agent.runs, []);
      assert.deepEqual(world.git.calls, []);
    });
  }

  it("writes nothing while the Issue is paused", async () => {
    const world = await deliveryWorld({
      issue: { labels: ["scope", "shaped", "pause"] },
    });
    seedReport(world, shapeVersion(world.issues));
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
    assert.deepEqual(world.issues.github.writes(), []);
  });

  it("writes no next action and stops when removing shaped fails", async () => {
    const world = await deliveryWorld();
    seedReport(world, shapeVersion(world.issues));
    world.issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/shaped", {
      data: [],
    });
    const error = await rejection(world.run());
    assert.equal((error as GitHubError).code, "GITHUB_WRITE_UNCONFIRMED");
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: true });
  });

  it("runs normally on a report for an older Shape version", async () => {
    const step: AgentStep = () => {
      commitFile(world.fixture.workspace, "w.txt", "w\n", "feat: w");
      return done;
    };
    const world = await deliveryWorld({ steps: [step, pass] });
    const version = shapeVersion(world.issues);
    seedReport(world, "1.1");
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
    for (const run of world.agent.runs) {
      assert.doesNotMatch(run.prompt, /drops the CLI flag/);
      assert.doesNotMatch(run.prompt, new RegExp(version.replace(".", "\\.")));
    }
  });

  it("asks for Shape on a start at shape with an unresolved report", async () => {
    const world = await deliveryWorld({ issue: { labels: ["scope"] } });
    seedReport(world, shapeVersion(world.issues));
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "shape", reason: null, progressed: false });
    assert.deepEqual(world.issues.github.writes(), []);
  });

  it("asks for nothing at shape when the report is resolved", async () => {
    const world = await deliveryWorld({ issue: { labels: ["scope"] } });
    const version = shapeVersion(world.issues);
    const resolved =
      "Resolved: a rewritten Shape was approved and written.\n" +
      `Rewritten as Shape version: ${version}\n\n${shapeWrongBody("1.1", reason)}`;
    seedReport(world, version, resolved);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
  });
});

describe("runDeliverStage with a review of another Shape version", () => {
  for (const [name, line] of [
    ["no Reviewed Shape line", ""],
    ["an older Shape version", "Reviewed Shape: 1.1"],
  ] as const) {
    for (const jobReason of ["review", undefined] as const) {
      it(`asks for a review on ${name} (${jobReason ?? "no reason"})`, async () => {
        const { world, head } = await openPullWorld({ reason: jobReason });
        reviewComment(world, head, line);
        assert.equal(await world.run(), 0);
        assert.deepEqual(next(world), {
          stage: "review",
          reason: null,
          progressed: false,
        });
        assert.deepEqual(world.agent.runs, []);
        assert.match(world.agent.logs.at(-1)!, /another Shape version; review again$/);
      });
    }
  }

  it("asks for a review when the Shape changes during a review fix", async () => {
    const step: AgentStep = () => {
      commitFile(world.fixture.workspace, "b.txt", "b\n", "fix: rename");
      editShape(world.issues, "An owner edit.");
      return done;
    };
    const { world, head } = await openPullWorld({
      reason: "review",
      steps: [step, pass],
    });
    reviewComment(world, head, `Reviewed Shape: ${shapeVersion(world.issues)}`);
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: false });
    assert.deepEqual(pushes(world), []);
  });

  it("asks for nothing on a review of an older head", async () => {
    const { world } = await openPullWorld({});
    reviewComment(world, "abcdef1", "");
    assert.equal(await world.run(), 0);
    assert.deepEqual(next(world), { stage: null, reason: null, progressed: false });
  });
});
