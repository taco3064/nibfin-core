import assert from "node:assert/strict";
import { test } from "node:test";
import * as stages from "./index.ts";

test("the stages module exports its public API", () => {
  assert.deepEqual(Object.keys(stages).toSorted(), [
    "StageError",
    "composePrompt",
    "defaultDeliverDeps",
    "defaultStageDeps",
    "deliverBlockedCommentKey",
    "deliverRunName",
    "fixReasons",
    "jobOptions",
    "loginCommentKey",
    "parseAgentResult",
    "parseJobOptions",
    "prepareStageJob",
    "readJobContext",
    "reviewCommentKey",
    "runDeliverStage",
    "runShapeStage",
    "runStageAgent",
    "shapeBlockedCommentKey",
    "shapeCommentKey",
    "writeNextAction",
  ]);
  assert.deepEqual(
    [
      stages.shapeCommentKey,
      stages.shapeBlockedCommentKey,
      stages.loginCommentKey,
      stages.deliverBlockedCommentKey,
      stages.reviewCommentKey,
    ],
    ["shape", "shape-blocked", "agent-login", "deliver-blocked", "review"],
  );
  assert.equal(
    stages.deliverRunName({ owner: "acme", repo: "app" }, 7),
    "Nibfin · acme/app#7 · deliver",
  );
});
