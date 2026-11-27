import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCommentVersions, readCommentWithVersions } from "./comment-edits.ts";
import { GitHubError, IncompleteAnswer, incompleteRead } from "./errors.ts";
import {
  type FakeGitHub,
  type FakeResponse,
  fakeGitHub,
  networkError,
  rejection,
  repo,
  sequence,
} from "./fake-github.test.ts";
import { operationOf } from "./fake-issue-record.test.ts";
import { readBlockingRecord, readIssueRecord } from "./issue-query.ts";
import { readForcePushedHeads } from "./pull-request.ts";
import { readOriginIssues, readRepositoryInventory } from "./request-sources.ts";
import { giveUpLine, retryCause, retryIncomplete } from "./retry.ts";

/** Call-level retries of reads whose answer arrived but was incomplete (#768, R4.37). */

const target = { owner: "acme", repo: "app", number: 1 };
const what = "GitHub read acme/app#1";

const retryLine = (name: string, k: number, cause: string, seconds: number) =>
  `${name} (retry ${k} of 3): ${cause}; waiting ${seconds} s`;

const graphqlCalls = (github: FakeGitHub) =>
  github.calls.filter((call) => call.path === "/graphql");

const pulls = () => ({ pageInfo: { hasNextPage: false }, nodes: [] });

/** A complete, minimal Issue-record answer. */
const complete: FakeResponse = {
  data: {
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          state: "OPEN",
          stateReason: null,
          url: "https://github.com/acme/app/issues/1",
          title: "T",
          body: "B",
          labels: { totalCount: 0, nodes: [] },
          assignees: { totalCount: 0, nodes: [] },
          issueDependenciesSummary: { totalBlockedBy: 0 },
          blockedBy: { nodes: [] },
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        delivery: pulls(),
        ref: null,
        fixRefs: { pageInfo: { hasNextPage: false }, nodes: [] },
        fix1: pulls(),
        fix2: pulls(),
        fix3: pulls(),
      },
    },
  },
};

/** `complete` with the Issue node replaced by `node`. */
function withIssueNode(node: unknown): FakeResponse {
  const answer = structuredClone(complete);
  const data = answer.data as { data: { repository: Record<string, unknown> } };
  data.data.repository.issueOrPullRequest = node;
  return answer;
}

/** The Issue just created over REST, which GraphQL does not resolve yet. */
const notFound = withIssueNode(null);

function record(...answers: Array<FakeResponse | ReturnType<typeof networkError>>) {
  return fakeGitHub({ "GRAPHQL IssueRecord": sequence(...answers) });
}

async function readFailure(promise: Promise<unknown>): Promise<GitHubError> {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(error.code, "GITHUB_READ_FAILED");
  return error;
}

describe("readIssueRecord retries", () => {
  it("returns the Issue after its query got no response twice", async () => {
    const github = record(networkError(), networkError(), complete);
    const read = await readIssueRecord(github.client, target);
    assert.equal(read.title, "T");
    assert.deepEqual(github.log, [
      retryLine("GitHub POST /graphql", 1, "no response", 1),
      retryLine("GitHub POST /graphql", 2, "no response", 4),
    ]);
    assert.equal(graphqlCalls(github).length, 3);
  });

  it("reads GitHub again after an incomplete answer, past the read cache", async () => {
    const github = record(notFound, notFound, complete);
    const read = await readIssueRecord(github.client, target);
    assert.equal(read.body, "B");
    assert.deepEqual(github.log, [
      retryLine(what, 1, "incomplete answer", 1),
      retryLine(what, 2, "incomplete answer", 4),
    ]);
    assert.deepEqual(github.waits, [1, 4]);
    assert.equal(graphqlCalls(github).length, 3);
  });

  it("fails with the incomplete answer after the third retry", async () => {
    const github = record(notFound);
    const error = await readFailure(readIssueRecord(github.client, target));
    assert.equal(error.message, "read acme/app#1: read failed (incomplete answer)");
    assert.ok(error.cause instanceof IncompleteAnswer);
    assert.equal(error.cause.message, "acme/app#1 was not found");
    assert.equal(graphqlCalls(github).length, 4);
    assert.deepEqual(github.log, [
      retryLine(what, 1, "incomplete answer", 1),
      retryLine(what, 2, "incomplete answer", 4),
      retryLine(what, 3, "incomplete answer", 9),
      giveUpLine(what, "incomplete answer"),
    ]);
  });

  it("does not retry a pull request number", async () => {
    const github = record(withIssueNode({ __typename: "PullRequest" }));
    const error = await readFailure(readIssueRecord(github.client, target));
    assert.equal(error.message, "read acme/app#1: read failed (no response)");
    assert.equal((error.cause as Error).message, "acme/app#1 is a pull request");
    assert.equal(graphqlCalls(github).length, 1);
    assert.deepEqual(github.log, []);
  });

  it("does not retry again a request the request hook gave up on", async () => {
    const github = record(networkError());
    const error = await readFailure(readIssueRecord(github.client, target));
    assert.equal(error.message, "read acme/app#1: read failed (no response)");
    assert.equal(graphqlCalls(github).length, 4);
    assert.ok(github.log.every((line) => line.startsWith("GitHub POST /graphql")));
    assert.equal(github.log.length, 4);
  });

  it("does not retry again a GraphQL errors answer", async () => {
    const github = record({ data: { data: null, errors: [{ message: "Bad" }] } });
    const error = await readFailure(readIssueRecord(github.client, target));
    assert.equal((error.cause as Error).message, "Bad");
    assert.equal(graphqlCalls(github).length, 4);
    assert.ok(!github.log.some((line) => line.includes("incomplete answer")));
  });
});

describe("other reads retry an incomplete answer", () => {
  it("readBlockingRecord", async () => {
    const github = fakeGitHub({
      "GRAPHQL IssueBlocking": sequence(
        { data: { data: { repository: { issue: null } } } },
        {
          data: {
            data: {
              repository: {
                issue: {
                  issueDependenciesSummary: { totalBlocking: 0 },
                  blocking: { nodes: [] },
                },
              },
            },
          },
        },
      ),
    });
    assert.deepEqual(await readBlockingRecord(github.client, target), []);
    assert.deepEqual(github.log, [
      retryLine("GitHub read blocking of acme/app#1", 1, "incomplete answer", 1),
    ]);
  });

  it("readOriginIssues and readRepositoryInventory", async () => {
    const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    let missing = 2;
    const github = fakeGitHub({
      "POST /graphql": (call) => {
        if (missing > 0) {
          missing -= 1;
          return { data: { data: { repository: null } } };
        }
        const operation = operationOf(call.body);
        const repository =
          operation === "RequestOrigins"
            ? { issue: { timelineItems: empty } }
            : { visibility: "PUBLIC", issues: empty, pullRequests: empty };
        return { data: { data: { repository } } };
      },
    });
    const request = { ...target, url: "https://github.com/acme/app/issues/1" };
    assert.deepEqual(await readOriginIssues(github.client, request), []);
    missing = 1;
    const inventory = await readRepositoryInventory(github.client, repo);
    assert.equal(inventory.visibility, "public");
    assert.deepEqual(github.log, [
      retryLine(
        "GitHub read the cross-references of acme/app#1",
        1,
        "incomplete answer",
        1,
      ),
      retryLine(
        "GitHub read the cross-references of acme/app#1",
        2,
        "incomplete answer",
        4,
      ),
      retryLine(
        "GitHub read the Issues and pull requests of acme/app",
        1,
        "incomplete answer",
        1,
      ),
    ]);
  });

  it("readCommentVersions and readCommentWithVersions", async () => {
    const node = { body: "x", userContentEdits: { totalCount: 2 } };
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/comments/9": { data: { id: 9, node_id: "IC_9" } },
      "POST /graphql": sequence(
        { data: { data: { node: {} } } },
        { data: { data: { node } } },
        { data: { data: { node: { userContentEdits: { totalCount: 2 } } } } },
        { data: { data: { node } } },
      ),
    });
    assert.equal(await readCommentVersions(github.client, repo, 9), 2);
    assert.deepEqual(await readCommentWithVersions(github.client, repo, 9), {
      body: "x",
      versions: 2,
    });
    const line = retryLine(
      "GitHub read edits of comment acme/app#9",
      1,
      "incomplete answer",
      1,
    );
    assert.deepEqual(github.log, [line, line]);
  });

  it("readForcePushedHeads", async () => {
    const timelineItems = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ beforeCommit: { oid: "a" } }],
    };
    const github = fakeGitHub({
      "POST /graphql": sequence(
        { data: { data: { repository: { pullRequest: null } } } },
        { data: { data: { repository: { pullRequest: { timelineItems } } } } },
      ),
    });
    assert.deepEqual(await readForcePushedHeads(github.client, repo, 7), ["a"]);
    assert.deepEqual(github.log, [
      retryLine("GitHub read force pushes of acme/app#7", 1, "incomplete answer", 1),
    ]);
  });
});

describe("retryIncomplete", () => {
  it("rethrows other errors at once", async () => {
    const github = fakeGitHub();
    let runs = 0;
    const failure = new Error("not a GitHub error");
    const error = await rejection(
      retryIncomplete(github.client, "probe", () => {
        runs += 1;
        return Promise.reject(failure);
      }),
    );
    assert.equal(error, failure);
    assert.equal(runs, 1);
  });

  it("does not retry again what a nested call gave up on", async () => {
    const github = fakeGitHub();
    let runs = 0;
    const inner = () =>
      retryIncomplete(github.client, "inner", () => {
        runs += 1;
        return Promise.reject(incompleteRead("inner", "Read 0 of 1 labels"));
      });
    const error = await readFailure(retryIncomplete(github.client, "outer", inner));
    assert.equal(error.operation, "inner");
    assert.equal(runs, 4);
    assert.equal(github.log.at(-1), giveUpLine("GitHub inner", "incomplete answer"));
    assert.ok(!github.log.some((line) => line.startsWith("GitHub outer")));
  });

  it("throws another error of the last attempt without a give-up line", async () => {
    const github = fakeGitHub();
    const failure = new Error("not a GitHub error");
    let runs = 0;
    const error = await rejection(
      retryIncomplete(github.client, "probe", () => {
        runs += 1;
        return Promise.reject(runs <= 3 ? incompleteRead("probe", "missing") : failure);
      }),
    );
    assert.equal(error, failure);
    assert.equal(runs, 4);
    assert.equal(github.log.length, 3);
  });

  it("names an incomplete answer in the log", () => {
    assert.equal(retryCause(incompleteRead("read x", "missing")), "incomplete answer");
  });
});
