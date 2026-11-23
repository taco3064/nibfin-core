import assert from "node:assert/strict";
import { test } from "node:test";
import * as stages from "./index.ts";

test("the stages module exports its public API", () => {
  assert.deepEqual(Object.keys(stages).toSorted(), [
    "StageError",
    "composePrompt",
    "defaultStageDeps",
    "jobOptions",
    "loginCommentKey",
    "parseAgentResult",
    "parseJobOptions",
    "prepareStageJob",
    "readJobContext",
    "runShapeStage",
    "runStageAgent",
    "shapeBlockedCommentKey",
    "shapeCommentKey",
  ]);
  assert.deepEqual(
    [stages.shapeCommentKey, stages.shapeBlockedCommentKey, stages.loginCommentKey],
    ["shape", "shape-blocked", "agent-login"],
  );
});
