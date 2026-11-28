import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, rejection, sequence } from "./fake-github.test.ts";
import {
  dispatchRepository,
  readDefaultBranch,
  readRepoOwnerId,
} from "./workflow-dispatch.ts";

const runRepo = { owner: "acme", repo: "runner" };
const e2e = { owner: "acme", repo: "e2e" };
const payload = { repository: "acme/app", issue: 7 };

describe("readRepoOwnerId", () => {
  it("returns owner.id from the repository read readDefaultBranch shares", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/runner": {
        data: { default_branch: "trunk", owner: { id: 31, login: "acme" } },
      },
    });
    assert.equal(await readRepoOwnerId(github.client, runRepo), 31);
    assert.equal(await readDefaultBranch(github.client, runRepo), "trunk");
    assert.equal(github.calls.length, 1);
  });
});

describe("dispatchRepository", () => {
  it("sends the event type and the payload as client_payload once", async () => {
    const github = fakeGitHub({ "POST /repos/acme/e2e/dispatches": { status: 204 } });
    await dispatchRepository(github.client, e2e, "issue-delivered", payload);
    assert.deepEqual(
      github.calls.map((call) => [call.method, call.path, call.body]),
      [
        [
          "POST",
          "/repos/acme/e2e/dispatches",
          { event_type: "issue-delivered", client_payload: payload },
        ],
      ],
    );
  });

  it("re-sends after a failure without reading first", async () => {
    const github = fakeGitHub({
      "POST /repos/acme/e2e/dispatches": sequence(failure(502), { status: 204 }),
    });
    await dispatchRepository(github.client, e2e, "issue-delivered", payload);
    assert.equal(github.calls.length, 2);
    assert.equal(github.waits.length, 1);
  });

  for (const [status, code] of [
    [500, "GITHUB_WRITE_UNCONFIRMED"],
    [422, "GITHUB_WRITE_REJECTED"],
  ] as const) {
    it(`gives up after the retries on ${status} as ${code}`, async () => {
      const github = fakeGitHub({ "POST /repos/acme/e2e/dispatches": failure(status) });
      const error = await rejection(
        dispatchRepository(github.client, e2e, "issue-delivered", payload),
      );
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, code);
      assert.match(error.message, /send issue-delivered to acme\/e2e/);
      assert.equal(github.calls.length, 4);
      assert.ok(github.log.every((line) => !line.includes("acme/app")));
    });
  }
});
