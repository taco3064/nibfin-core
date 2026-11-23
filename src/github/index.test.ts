import assert from "node:assert/strict";
import { test } from "node:test";
import * as github from "./index.ts";

test("the github module exports its public API", () => {
  assert.deepEqual(Object.keys(github).toSorted(), [
    "GitHubError",
    "cdFixBranch",
    "closeDelivered",
    "commentMarker",
    "commitStatusState",
    "createClient",
    "defaultSnapshotReaders",
    "deliveryBranch",
    "deliveryOutcome",
    "deriveStage",
    "ensurePullRequest",
    "findMarkedComment",
    "isNibfinWorkflow",
    "nibfinLabels",
    "nibfinWorkflowPrefix",
    "probeBranch",
    "readBlockedBy",
    "readBlocking",
    "readCdRuns",
    "readCi",
    "readDependencies",
    "readIssueBranches",
    "readIssueSnapshot",
    "readIssueText",
    "readJobLog",
    "readPullRequests",
    "readRequiredCheckResults",
    "readRequiredChecks",
    "readRunJobs",
    "runState",
    "setLabels",
    "upsertMarkedComment",
  ]);
});
