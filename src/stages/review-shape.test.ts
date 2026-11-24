import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addPullComment, type ReviewWorld, reviewWorld } from "./fake-review.test.ts";
import {
  agentResult,
  type AgentStep,
  editShape,
  seedComment,
  shapeVersion,
} from "./fake-job.test.ts";
import { shapeWrongBody } from "./shape-wrong.ts";

const reviewMarker = "<!-- nibfin:review -->";
const wrongMarker = "<!-- nibfin:shape-wrong -->";

/** A review world whose scripted agent runs can read the world once it exists. */
async function world(steps: (w: () => ReviewWorld) => AgentStep[]) {
  const holder: { world?: ReviewWorld } = {};
  holder.world = await reviewWorld({ steps: steps(() => holder.world!) });
  return holder.world;
}

function verdict(w: () => ReviewWorld, value: Record<string, unknown>) {
  return (): string => agentResult({ reviewedHead: w().head, ...value });
}

function reportPending(w: ReviewWorld) {
  const body = shapeWrongBody(shapeVersion(w.issues), "The Shape is wrong.");
  seedComment(w.issues, w.issues.main, `${wrongMarker}\n${body}`);
}

function reviewBody(w: ReviewWorld, shapeLine: string, text = "Problems: X") {
  return `${reviewMarker}\nReviewed head: ${w.head}\n${shapeLine}\n\n${text}`;
}

function prComments(w: ReviewWorld): string[] {
  return (w.pullComments.get(7) ?? []).map((comment) => comment.body);
}

describe("runReviewStage and the Shape version", () => {
  it("records the version of the Shape the reviewer read", async () => {
    const w = await world((get) => [
      () => {
        editShape(get().issues, "An owner edit.");
        return verdict(get, { outcome: "problems", problems: ["X"] })();
      },
    ]);
    const read = shapeVersion(w.issues);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: "review", progressed: true });
    assert.deepEqual(prComments(w), [
      reviewBody(w, `Reviewed Shape: ${read}`, "Problems found in the review:\n\n- X"),
    ]);
    assert.notEqual(shapeVersion(w.issues), read);
  });

  it("reuses a review of the current head and Shape version", async () => {
    const w = await world(() => []);
    addPullComment(w, 7, reviewBody(w, `Reviewed Shape: ${shapeVersion(w.issues)}`));
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: "review", progressed: false });
    assert.deepEqual(w.agent.runs, []);
    assert.deepEqual(w.issues.github.writes(), []);
  });

  for (const [name, line] of [
    ["without a Reviewed Shape line", ""],
    ["of another Shape version", "Reviewed Shape: 1.1"],
  ] as const) {
    it(`reviews again a comment ${name}`, async () => {
      const w = await world((get) => [verdict(get, { outcome: "clean" })]);
      addPullComment(w, 7, reviewBody(w, line));
      assert.equal(await w.review(), 0);
      assert.equal(w.agent.runs.length, 1);
      assert.equal(w.mergeRequests.length, 1);
      assert.ok(
        w.agent.logs.some((l) => l.endsWith("written for another Shape version")),
      );
    });
  }

  it("makes identical problems after a rewrite count again", async () => {
    const problems = "Problems found in the review:\n\n- X";
    const w = await world((get) => [
      verdict(get, { outcome: "problems", problems: ["X"] }),
    ]);
    const comment = addPullComment(w, 7, reviewBody(w, "Reviewed Shape: 1.1", problems));
    assert.equal(await w.review(), 0);
    assert.equal(
      comment.body,
      reviewBody(w, `Reviewed Shape: ${shapeVersion(w.issues)}`, problems),
    );
    assert.deepEqual(w.next(), { stage: "deliver", reason: "review", progressed: true });
  });
});

describe("runReviewStage with a pending Shape report", () => {
  for (const withComment of [false, true]) {
    const name = withComment ? "with" : "without";
    it(`neither reviews nor merges (${name} a review comment)`, async () => {
      const w = await world(() => []);
      if (withComment) {
        addPullComment(w, 7, reviewBody(w, `Reviewed Shape: ${shapeVersion(w.issues)}`));
      }
      reportPending(w);
      assert.equal(await w.review(), 0);
      assert.deepEqual(w.next(), { stage: "deliver", reason: null, progressed: false });
      assert.deepEqual(w.agent.runs, []);
      assert.deepEqual(w.mergeRequests, []);
      assert.deepEqual(w.issues.github.writes(), []);
    });
  }

  it("re-checks right before merging", async () => {
    const w = await world((get) => [
      () => {
        reportPending(get());
        return verdict(get, { outcome: "clean" })();
      },
    ]);
    assert.equal(await w.review(), 0);
    assert.deepEqual(w.next(), { stage: "deliver", reason: null, progressed: false });
    assert.deepEqual(w.mergeRequests, []);
    assert.deepEqual(prComments(w), []);
    assert.match(w.agent.logs.at(-1)!, /^Not merging: the Shape is reported wrong/);
  });

  it("ignores a report for an older Shape version", async () => {
    const w = await world((get) => [verdict(get, { outcome: "clean" })]);
    const body = shapeWrongBody("1.1", "Old.");
    seedComment(w.issues, w.issues.main, `${wrongMarker}\n${body}`);
    assert.equal(await w.review(), 0);
    assert.equal(w.mergeRequests.length, 1);
  });
});
