import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, maxRetries, retryDelay } from "./client.ts";
import { absentProbe, GitHubError, read, rateLimitOf, readOptional } from "./errors.ts";
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
import { retrySettingsOf } from "./read-cache.ts";
import { realWait, requestName, retryCause } from "./retry.ts";

const repo = { owner: "acme", repo: "app" };

/** A primary rate limit whose reset already passed, so the wait is 0 s. */
const primary: FakeResponse = {
  status: 403,
  data: { message: "API rate limit exceeded for user ID 42." },
  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
};

const secondary = (status: number, retryAfter?: string): FakeResponse => ({
  status,
  data: { message: "You have exceeded a secondary rate limit." },
  headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
});

const graphqlLimited: FakeResponse = {
  data: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit" }] },
  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
};

const graphqlFailed: FakeResponse = {
  data: { data: null, errors: [{ type: "INTERNAL", message: "Something went wrong" }] },
};

const ok: FakeResponse = { data: { id: 1 } };

async function readRepo(client: ReturnType<typeof fakeGitHub>["client"]) {
  return read("read acme/app", () => client.request("GET /repos/{owner}/{repo}", repo));
}

const retryLine = (what: string, k: number, cause: string, seconds: number) =>
  `${what} (retry ${k} of 3): ${cause}; waiting ${seconds} s`;

describe("retries of reads", () => {
  it("retries any error and succeeds on the third retry", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(failure(502), networkError(), failure(422), ok),
    });
    assert.deepEqual((await readRepo(github.client)).data, { id: 1 });
    assert.equal(maxRetries, 3);
    assert.equal(github.calls.length, 4);
    assert.deepEqual(github.waits, [1, 4, 9]);
    const what = "GitHub GET /repos/acme/app";
    assert.deepEqual(github.log, [
      retryLine(what, 1, "HTTP 502", 1),
      retryLine(what, 2, "no response", 4),
      retryLine(what, 3, "HTTP 422", 9),
    ]);
  });

  it("fails as before after the third retry", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": failure(503) });
    const error = await rejection(readRepo(github.client));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(error.message, "read acme/app: read failed (HTTP 503)");
    assert.equal(github.calls.length, 4);
    assert.equal(
      github.log.at(-1),
      "GitHub GET /repos/acme/app: HTTP 503; not retrying after 3 retries",
    );
  });

  it("retries every 4xx, including a 404 read as an error", async () => {
    for (const status of [400, 401, 403, 404, 410, 422, 429, 451]) {
      const github = fakeGitHub({
        "GET /repos/acme/app": sequence(failure(status), ok),
      });
      assert.deepEqual((await readRepo(github.client)).data, { id: 1 });
      assert.equal(github.calls.length, 2, `HTTP ${status}`);
    }
  });

  it("does not retry the 404 of an absent probe, but any other failure", async () => {
    const path = "/repos/acme/app/git/ref/heads/x";
    const github = fakeGitHub({ [`GET ${path}`]: failure(404) });
    const probe = (request?: object) =>
      readOptional("read ref", () =>
        github.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ...repo,
          ref: "heads/x",
          request,
        }),
      );
    assert.equal(await probe(absentProbe), undefined);
    assert.equal(github.calls.length, 1);
    assert.deepEqual(github.log, []);
    // A plain read of the same URL is not answered by the probe, and retries.
    assert.equal(await probe(), undefined);
    assert.equal(github.calls.length, 5);
    github.routes.set(`GET ${path}`, sequence(failure(500), primary, failure(404)));
    assert.equal(await probe(absentProbe), undefined);
    assert.equal(github.calls.length, 8);
  });

  it("retries a GraphQL answer with errors and returns the last one", async () => {
    const github = fakeGitHub({
      "POST /graphql": sequence(graphqlFailed, { data: { data: { ok: true } } }),
    });
    const answer = await github.client.request("POST /graphql", { query: "query { a }" });
    assert.deepEqual(answer.data, { data: { ok: true } });
    assert.deepEqual(github.log, [
      retryLine("GitHub POST /graphql", 1, "GraphQL error", 1),
    ]);
    const failing = fakeGitHub({ "POST /graphql": graphqlFailed });
    const last = await failing.client.request("POST /graphql", { query: "query { b }" });
    assert.deepEqual(last.data, graphqlFailed.data);
    assert.equal(failing.calls.length, 4);
    assert.equal(
      failing.log.at(-1),
      "GitHub POST /graphql: GraphQL error; not retrying after 3 retries",
    );
  });

  it("retries a GraphQL query that got no response or a server error", async () => {
    const github = fakeGitHub({
      "POST /graphql": sequence(failure(500), networkError(), {
        data: { data: { ok: 1 } },
      }),
    });
    const answer = await github.client.request("POST /graphql", { query: "query { a }" });
    assert.deepEqual(answer.data, { data: { ok: 1 } });
    assert.equal(github.calls.length, 3);
  });

  it("logs the path only, never the query string", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues": sequence(failure(500), paged([])),
    });
    await github.client.paginate("GET /repos/{owner}/{repo}/issues", {
      ...repo,
      per_page: 100,
      labels: "secret-label",
    });
    assert.deepEqual(github.log, [
      retryLine("GitHub GET /repos/acme/app/issues", 1, "HTTP 500", 1),
    ]);
  });

  it("passes writes through: write() retries them", async () => {
    for (const route of [failure(502), networkError(), failure(422), secondary(403)]) {
      const github = fakeGitHub({ "PATCH /repos/acme/app/issues/1": route });
      await rejection(
        github.client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          ...repo,
          issue_number: 1,
          state: "closed",
        }),
      );
      assert.equal(github.calls.length, 1);
      assert.deepEqual(github.log, []);
    }
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

describe("rate limits", () => {
  it("waits out a primary rate limit within the same three retries", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(primary, failure(500), ok),
    });
    assert.deepEqual((await readRepo(github.client)).data, { id: 1 });
    assert.deepEqual(github.log, [
      retryLine("GitHub GET /repos/acme/app", 1, "primary rate limit", 0),
      retryLine("GitHub GET /repos/acme/app", 2, "HTTP 500", 4),
    ]);
  });

  it("stops after three retries and names the rate limit as the cause", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": primary });
    const error = await rejection(readRepo(github.client));
    assert.ok(error instanceof GitHubError);
    assert.equal(
      error.message,
      "read acme/app: read failed (HTTP 403, rate limited (primary))",
    );
    assert.equal(rateLimitOf(error.cause), "primary");
    assert.equal(github.calls.length, 4);
    assert.equal(
      github.log.at(-1),
      "GitHub GET /repos/acme/app: primary rate limit; not retrying after 3 retries",
    );
  });

  it("waits retry-after on a secondary rate limit, else one minute", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(secondary(403, "7"), secondary(429), ok),
    });
    assert.deepEqual((await readRepo(github.client)).data, { id: 1 });
    assert.deepEqual(github.waits, [7, 60]);
    assert.match(github.log[0], /: secondary rate limit; waiting 7 s$/);
  });

  it("waits out a GraphQL rate limit answered with 200", async () => {
    const github = fakeGitHub({
      "POST /graphql": sequence(graphqlLimited, { data: { data: { ok: true } } }),
    });
    const answer = await github.client.request("POST /graphql", { query: "query { a }" });
    assert.deepEqual(answer.data, { data: { ok: true } });
    assert.deepEqual(github.log, [
      retryLine("GitHub POST /graphql", 1, "primary rate limit", 0),
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
    assert.equal(limited.calls.length, 4);
  });
});

describe("retryDelay", () => {
  const limited = (headers: Record<string, string>, message = "API rate limit") => ({
    status: 403,
    message,
    response: { headers, data: {} },
  });

  it("waits until the primary reset, or a minute when GitHub names none", () => {
    const now = 1_000_000_000;
    const reset = limited({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1000030",
    });
    assert.equal(retryDelay(reset, 1, now), 31);
    const graphql = {
      message: "GraphQL Rate Limit Exceeded",
      response: { data: { errors: [{ type: "RATE_LIMITED" }] } },
    };
    assert.equal(retryDelay(graphql, 1, now), 60);
  });

  it("unwraps a GitHubError and grows the wait for other errors", () => {
    const wrapped = new GitHubError(
      "GITHUB_WRITE_REJECTED",
      "x",
      limited({ "retry-after": "5" }, "secondary rate limit"),
    );
    assert.equal(retryDelay(wrapped, 2), 5);
    assert.equal(retryCause(wrapped), "secondary rate limit");
    assert.equal(retryCause({ response: { data: {} } }), "GraphQL error");
    assert.deepEqual(
      [1, 2, 3].map((k) => retryDelay(undefined, k)),
      [1, 4, 9],
    );
  });

  it("names a request only from what the error carries", () => {
    assert.equal(requestName(undefined, "fallback"), "fallback");
    assert.equal(requestName({ request: { method: "GET" } }, "fallback"), "fallback");
    const error = { request: { method: "PUT", url: "https://api.github.com/a?b=1" } };
    assert.equal(requestName(error, "fallback"), "GitHub PUT /a");
  });

  it("waits for real on a client built without settings", async () => {
    const settings = retrySettingsOf({});
    settings.log("ignored");
    await settings.wait(0);
    await realWait(0);
  });
});
