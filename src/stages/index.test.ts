import assert from "node:assert/strict";
import { test } from "node:test";
import * as stages from "./index.ts";

test("the stages module exports its public API", () => {
  assert.deepEqual(Object.keys(stages).toSorted(), [
    "StageError",
    "composePrompt",
    "defaultDeliverDeps",
    "defaultReviewDeps",
    "defaultStageDeps",
    "deliverBlockedCommentKey",
    "deliverRunName",
    "deliveredCommentKey",
    "fixReasons",
    "jobOptions",
    "loginCommentKey",
    "parseAgentResult",
    "parseJobOptions",
    "prepareStageJob",
    "readJobContext",
    "reviewBlockedCommentKey",
    "reviewCommentKey",
    "runDeliverStage",
    "runReviewStage",
    "runShapeStage",
    "runStageAgent",
    "shapeBlockedCommentKey",
    "shapeCommentKey",
    "shapeWrongCommentKey",
    "writeNextAction",
  ]);
  assert.deepEqual(
    [
      stages.shapeCommentKey,
      stages.shapeBlockedCommentKey,
      stages.loginCommentKey,
      stages.deliverBlockedCommentKey,
      stages.reviewCommentKey,
      stages.reviewBlockedCommentKey,
      stages.deliveredCommentKey,
      stages.shapeWrongCommentKey,
    ],
    [
      "shape",
      "shape-blocked",
      "agent-login",
      "deliver-blocked",
      "review",
      "review-blocked",
      "delivered",
      "shape-wrong",
    ],
  );
  assert.equal(
    stages.deliverRunName({ owner: "acme", repo: "app" }, 7),
    "Nibfin · acme/app#7 · deliver",
  );
});
