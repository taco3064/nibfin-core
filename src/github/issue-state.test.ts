import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, rejection, type Route } from "./fake-github.test.ts";
import { closeIssueNotPlanned, readIssueState } from "./issue-state.ts";

const issue = { owner: "acme", repo: "app", number: 7 };
const path = "/repos/acme/app/issues/7";

/** A fake Issue whose REST state a `PATCH` closes. */
function world(state = "open", patch?: Route) {
  const current = { state };
  const github = fakeGitHub({
    [`GET ${path}`]: () => ({ data: { number: 7, state: current.state } }),
    [`PATCH ${path}`]:
      patch ??
      ((request) => {
        current.state = (request.body as { state: string }).state;
        return { data: { number: 7, state: current.state } };
      }),
  });
  return { github, current };
}

describe("readIssueState", () => {
  it("reads the state over REST", async () => {
    assert.equal(await readIssueState(world("closed").github.client, issue), "closed");
  });

  it("fails as a read", async () => {
    const error = await rejection(readIssueState(fakeGitHub().client, issue));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("closeIssueNotPlanned", () => {
  it("closes an open Issue as not planned over REST", async () => {
    const { github, current } = world();
    await closeIssueNotPlanned(github.client, issue);
    assert.equal(current.state, "closed");
    assert.deepEqual(
      github.writes().map((call) => [call.method, call.path, call.body]),
      [["PATCH", path, { state: "closed", state_reason: "not_planned" }]],
    );
    assert.ok(github.calls.every((call) => call.path !== "/graphql"));
  });

  it("leaves a closed Issue as it is", async () => {
    const { github } = world("closed");
    await closeIssueNotPlanned(github.client, issue);
    assert.deepEqual(github.writes(), []);
  });

  it("confirms with a fresh read before a re-send", async () => {
    const { github, current } = world("open", (request) => {
      current.state = (request.body as { state: string }).state;
      return failure(502);
    });
    await closeIssueNotPlanned(github.client, issue);
    assert.equal(github.writes().length, 1);
    const reads = github.calls.filter((call) => call.method === "GET");
    assert.equal(reads.length, 2);
  });

  it("fails as rejected when it cannot close", async () => {
    const { github } = world("open", failure(403));
    const error = await rejection(closeIssueNotPlanned(github.client, issue));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_REJECTED");
  });
});
