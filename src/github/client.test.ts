import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, primaryRetries, secondaryRetries } from "./client.ts";
import { GitHubError, read, rateLimitOf } from "./errors.ts";
import {
  failure,
  fakeActor,
  fakeGitHub,
  fakeToken,
  type FakeResponse,
  networkError,
  paged,
  rejection,
  sequence,
  testClientOptions,
} from "./fake-github.test.ts";

const repo = { owner: "acme", repo: "app" };

/** A primary rate limit whose reset already passed, so the wait is 0 s. */
const primary: FakeResponse = {
  status: 403,
  data: { message: "API rate limit exceeded for user ID 42." },
  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
};

const secondary = (status: number, retryAfter = "7"): FakeResponse => ({
  status,
  data: { message: "You have exceeded a secondary rate limit." },
  headers: { "retry-after": retryAfter },
});

const graphqlLimited: FakeResponse = {
  data: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit" }] },
  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
};

async function readRepo(client: ReturnType<typeof fakeGitHub>["client"]) {
  return read("read acme/app", () => client.request("GET /repos/{owner}/{repo}", repo));
}

describe("rate limits", () => {
  it("waits out a primary rate limit and continues, logging the wait", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(primary, { data: { id: 1 } }),
    });
    assert.deepEqual((await readRepo(github.client)).data, { id: 1 });
    assert.equal(github.calls.length, 2);
    assert.deepEqual(github.log, [
      "GitHub primary rate limit on GET /repos/acme/app: waiting 0 s (retry 1 of 2)",
    ]);
  });

  it("stops after its retries and names the rate limit as the cause", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": primary });
    const error = await rejection(readRepo(github.client));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(
      error.message,
      "read acme/app: read failed (HTTP 403, rate limited (primary))",
    );
    assert.equal(rateLimitOf(error.cause), "primary");
    assert.equal(github.calls.length, primaryRetries + 1);
    assert.equal(
      github.log.at(-1),
      "GitHub primary rate limit on GET /repos/acme/app: not retrying after 2 retries",
    );
  });

  it("retries a write rejected by a secondary rate limit after retry-after", async () => {
    const path = "/repos/acme/app/issues/1/comments";
    const github = fakeGitHub({
      [`POST ${path}`]: sequence(secondary(403), secondary(429, "3"), {
        status: 201,
        data: { id: 5 },
      }),
    });
    const { data } = await github.client.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { ...repo, issue_number: 1, body: "x" },
    );
    assert.deepEqual(data, { id: 5 });
    assert.equal(github.writes().length, 3);
    assert.deepEqual(github.log, [
      `GitHub secondary rate limit on POST ${path}: waiting 7 s (retry 1 of 4)`,
      `GitHub secondary rate limit on POST ${path}: waiting 3 s (retry 2 of 4)`,
    ]);
  });

  it("gives up on a secondary rate limit after its retries", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": secondary(403) });
    const error = await rejection(readRepo(github.client));
    assert.match(String(error), /\(HTTP 403, rate limited \(secondary\)\)$/);
    assert.equal(github.calls.length, secondaryRetries + 1);
    assert.match(github.log.at(-1)!, /: not retrying after 4 retries$/);
  });

  it("waits out a GraphQL rate limit answered with 200", async () => {
    const github = fakeGitHub({
      "POST /graphql": sequence(graphqlLimited, { data: { data: { ok: true } } }),
    });
    const answer = await github.client.request("POST /graphql", { query: "query { a }" });
    assert.deepEqual(answer.data, { data: { ok: true } });
    assert.deepEqual(github.log, [
      "GitHub primary rate limit on POST /graphql: waiting 0 s (retry 1 of 2)",
    ]);
    const limited = fakeGitHub({ "POST /graphql": graphqlLimited });
    const error = await rejection(
      read("query", () =>
        limited.client.request("POST /graphql", { query: "query { b }" }),
      ),
    );
    assert.equal(
      (error as GitHubError).message,
      "query: read failed (GraphQL, rate limited (primary))",
    );
  });

  it("logs the path only, never the query string", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues": sequence(primary, paged([])),
    });
    await github.client.paginate("GET /repos/{owner}/{repo}/issues", {
      ...repo,
      per_page: 100,
      labels: "secret-label",
    });
    assert.deepEqual(github.log, [
      "GitHub primary rate limit on GET /repos/acme/app/issues: " +
        "waiting 0 s (retry 1 of 2)",
    ]);
  });

  it("writes nothing to the Job log by default", async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      const { status, data, headers } = calls === 1 ? primary : { status: 200, data: {} };
      return Promise.resolve(Response.json(data, { status, headers }));
    };
    const client = createClient(fakeToken, fakeActor, testClientOptions(fetch));
    await client.request("GET /rate_limit");
    assert.equal(calls, 2);
  });
});

describe("retries after a server error or no response", () => {
  it("retries reads, including GraphQL queries", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(failure(502), networkError(), { data: { id: 2 } }),
      "POST /graphql": sequence(failure(500), { data: { data: { ok: 1 } } }),
    });
    assert.deepEqual((await readRepo(github.client)).data, { id: 2 });
    await github.client.request("POST /graphql", { query: "query { a }" });
    assert.equal(github.calls.length, 5);
  });

  it("stops retrying a read after three retries", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": failure(503) });
    await rejection(readRepo(github.client));
    assert.equal(github.calls.length, 4);
  });

  it("never re-sends a write", async () => {
    for (const route of [failure(502), networkError()]) {
      const github = fakeGitHub({ "PATCH /repos/acme/app/issues/1": route });
      await rejection(
        github.client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          ...repo,
          issue_number: 1,
          state: "closed",
        }),
      );
      assert.equal(github.calls.length, 1);
    }
  });

  it("does not retry client errors", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": failure(429) });
    await rejection(readRepo(github.client));
    assert.equal(github.calls.length, 1);
    assert.deepEqual(github.log, []);
  });
});
