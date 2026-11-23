import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, networkError, rejection } from "../github/fake-github.test.ts";
import {
  deriveStage,
  GitHubError,
  type PullRequestState,
  readIssueSnapshot,
} from "../github/index.ts";
import { StageError } from "./errors.ts";
import { mergePull, type ReviewWorld, reviewWorld } from "./fake-review.test.ts";
import { mergeReviewed } from "./review-merge.ts";

/** Merges the world's pull request as the stage would after a clean review. */
async function merge(w: ReviewWorld, head = w.head) {
  const { client } = w.issues.github;
  const stage = deriveStage(await readIssueSnapshot(client, w.context.repo, 1));
  const pull = (stage as { pullRequest: PullRequestState }).pullRequest;
  const scope = { context: w.context, client, deps: w.reviewDeps };
  return mergeReviewed(scope, pull, head, shapeVersion);
}

/** The Shape version the clean review read. */
const shapeVersion = "1000.1";
const noNext = { stage: null, reason: null };
const reviewFix = { stage: "deliver", reason: "review" };

function reviewComments(w: ReviewWorld): string[] {
  return (w.pullComments.get(7) ?? []).map((comment) => comment.body);
}

function blockedText(w: ReviewWorld): string {
  return w.issues.marked("review-blocked")[0]?.body ?? "";
}

async function expectBlocked(w: ReviewWorld, pattern: RegExp) {
  const error = await rejection(merge(w));
  assert.ok(error instanceof StageError, String(error));
  assert.equal(error.code, "STAGE_BLOCKED");
  assert.match(blockedText(w), pattern);
}

describe("mergeReviewed", () => {
  it("does not merge when the Issue was paused meanwhile", async () => {
    const w = await reviewWorld();
    const { client } = w.issues.github;
    const stage = deriveStage(await readIssueSnapshot(client, w.context.repo, 1));
    w.issues.main.labels.push("pause");
    const pull = (stage as { pullRequest: PullRequestState }).pullRequest;
    const scope = { context: w.context, client, deps: w.reviewDeps };
    assert.deepEqual(await mergeReviewed(scope, pull, w.head, shapeVersion), noNext);
    assert.deepEqual(w.mergeRequests, []);
    assert.match(w.agent.logs.at(-1)!, /ineligible \(paused\)/);
  });

  it("does not merge another head", async () => {
    const w = await reviewWorld();
    assert.deepEqual(await merge(w, "f".repeat(40)), noNext);
    assert.deepEqual(w.mergeRequests, []);
  });

  it("does not merge when the pull request moved on or closed", async () => {
    const w = await reviewWorld();
    const { client } = w.issues.github;
    const stage = deriveStage(await readIssueSnapshot(client, w.context.repo, 1));
    const pull = (stage as { pullRequest: PullRequestState }).pullRequest;
    const scope = { context: w.context, client, deps: w.reviewDeps };
    // The snapshot still lists it open; the pull request itself is closed now.
    const routes = w.issues.github.routes;
    const get = routes.get.bind(routes);
    routes.get = (key) => {
      const route = get(key);
      if (key !== "GET /repos/acme/app/pulls/7" || typeof route !== "function") {
        return route;
      }
      return async (request) => {
        const answer = await route(request);
        return { data: { ...(answer.data as object), state: "closed" } };
      };
    };
    assert.deepEqual(await mergeReviewed(scope, pull, w.head, shapeVersion), noNext);
    assert.deepEqual(w.mergeRequests, []);
  });

  for (const [mergeable, state] of [
    [null, "unknown"],
    [true, "unknown"],
  ] as const) {
    it(`waits while mergeable is ${mergeable} and the state ${state}`, async () => {
      const w = await reviewWorld();
      w.mergeable = mergeable;
      w.mergeableState = state;
      assert.deepEqual(await merge(w), noNext);
      assert.deepEqual(w.mergeRequests, []);
      assert.deepEqual(w.issues.github.writes(), []);
    });
  }

  for (const state of ["behind", "dirty"]) {
    it(`sends a ${state} pull request back to Deliver to rebase`, async () => {
      const w = await reviewWorld();
      w.mergeableState = state;
      assert.deepEqual(await merge(w), reviewFix);
      assert.deepEqual(reviewComments(w), [
        `<!-- nibfin:review -->\nReviewed head: ${w.head}\n` +
          `Reviewed Shape: ${shapeVersion}\n\nRebase onto \`main\` and ` +
          `resolve conflicts: GitHub reports \`mergeable_state: ${state}\`.`,
      ]);
      assert.deepEqual(w.mergeRequests, []);
    });
  }

  it("names unmet ruleset requirements of a blocked pull request", async () => {
    const w = await reviewWorld();
    w.mergeableState = "blocked";
    w.rules.push({
      type: "pull_request",
      parameters: {
        required_approving_review_count: 2,
        require_code_owner_review: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
        dismiss_stale_reviews_on_push: false,
      },
    });
    w.reviews.push({ id: 1, user: { id: 3, login: "a" }, state: "APPROVED" });
    await expectBlocked(w, /requires 2 approving review\(s\); the pull request has 1\./);
    const text = blockedText(w);
    assert.match(text, /code owner/);
    assert.match(text, /most recent push/);
    assert.match(text, /review thread/);
    assert.deepEqual(w.mergeRequests, []);
  });

  it("says when no readable rule explains a blocked pull request", async () => {
    const w = await reviewWorld();
    w.mergeableState = "blocked";
    w.rules.push({
      type: "pull_request",
      parameters: { required_approving_review_count: 1 },
    });
    w.reviews.push({ id: 1, user: { id: 3, login: "a" }, state: "APPROVED" });
    await expectBlocked(w, /classic branch protection/);
  });

  it("uses the first method the settings and rulesets allow", async () => {
    const w = await reviewWorld();
    w.mergeableState = "unstable";
    w.rules.push(
      {
        type: "pull_request",
        parameters: { allowed_merge_methods: ["merge", "squash"] },
      },
      { type: "required_linear_history" },
    );
    assert.deepEqual(await merge(w), noNext);
    assert.deepEqual(
      w.mergeRequests.map((request) => request.body),
      [{ sha: w.head, merge_method: "squash" }],
    );
    assert.equal(w.pull.merged, true);
  });

  it("blocks when no method is allowed or the settings are unknown", async () => {
    const none = await reviewWorld();
    none.settings = {
      allow_rebase_merge: false,
      allow_squash_merge: false,
      allow_merge_commit: true,
    };
    none.rules.push({ type: "required_linear_history" });
    await expectBlocked(none, /No merge method is allowed/);
    const unknown = await reviewWorld();
    unknown.settings = {};
    await expectBlocked(unknown, /merge settings are not readable/);
    assert.deepEqual([...none.mergeRequests, ...unknown.mergeRequests], []);
  });

  it("stops when GitHub reports the head changed (409)", async () => {
    const w = await reviewWorld();
    w.mergeAnswer = () => failure(409, "Head branch was modified.");
    assert.deepEqual(await merge(w), noNext);
    assert.match(w.agent.logs.at(-1)!, /no longer/);
  });

  it("sends a 405 for a moved base back to Deliver", async () => {
    const w = await reviewWorld();
    w.mergeAnswer = () => failure(405, "Base branch was modified. Review and try again.");
    assert.deepEqual(await merge(w), reviewFix);
    assert.match(reviewComments(w)[0], /Rebase onto `main` and resolve conflicts: Base/);
  });

  it("stops on a 405 for a moved head", async () => {
    const w = await reviewWorld();
    w.mergeAnswer = () => failure(405, "Head branch was modified. Review and try again.");
    assert.deepEqual(await merge(w), noNext);
    assert.deepEqual(reviewComments(w), []);
  });

  it("blocks on any other 405 with GitHub's message", async () => {
    const w = await reviewWorld();
    w.mergeAnswer = () => failure(405, "At least 1 approving review is required.");
    await expectBlocked(w, /did not merge .* At least 1 approving review is required/);
  });

  for (const status of [403, 405, 422]) {
    it(`names the workflows permission when GitHub rejects with ${status}`, async () => {
      const w = await reviewWorld();
      const message =
        "refusing to allow a GitHub App to create or update workflow " +
        "`.github/workflows/ci.yml` without `workflows` permission";
      w.mergeAnswer = () => failure(status, message);
      await expectBlocked(w, /lacks the workflows permission/);
    });
  }

  it("rethrows other rejections", async () => {
    const w = await reviewWorld();
    w.mergeAnswer = () => failure(403, "Resource not accessible by integration");
    const error = await rejection(merge(w));
    assert.equal((error as GitHubError).code, "GITHUB_WRITE_REJECTED");
    const silent = await reviewWorld();
    silent.mergeAnswer = () => ({ status: 422, data: {} });
    const other = await rejection(merge(silent));
    assert.equal((other as GitHubError).code, "GITHUB_WRITE_REJECTED");
  });

  it("confirms an unknown outcome by re-reading, never retrying", async () => {
    const merged = await reviewWorld();
    merged.mergeAnswer = () => {
      mergePull(merged, merged.pull);
      merged.pull.mergeSha = null;
      return failure(502);
    };
    assert.deepEqual(await merge(merged), noNext);
    assert.ok(merged.agent.logs.some((line) => line.endsWith("as (unknown)")));
    const lost = await reviewWorld();
    lost.mergeAnswer = networkError() as never;
    const error = await rejection(merge(lost));
    assert.equal((error as GitHubError).code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(lost.mergeRequests.length, 1);
  });
});
