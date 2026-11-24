import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failure,
  fakeGitHub,
  paged,
  rejection,
  repo,
  sequence,
} from "./fake-github.test.ts";
import { freshReads, isReadRequest, shareReadCache } from "./read-cache.ts";

const route = "GET /repos/{owner}/{repo}";

type Fake = ReturnType<typeof fakeGitHub>;

/** The fake repository read, typed as the counting route answers it. */
async function readCount(github: Fake): Promise<number> {
  const { data } = await github.client.request(route, repo);
  return (data as unknown as { reads: number }).reads;
}

function counting() {
  let reads = 0;
  const github = fakeGitHub({
    "GET /repos/acme/app": () => ({ data: { reads: ++reads, nested: { list: [1] } } }),
    "POST /repos/acme/app/issues": { status: 201, data: {} },
    "PATCH /repos/acme/app/issues/1": failure(422),
    "POST /graphql": (request) => ({ data: { data: request.body } }),
  });
  return github;
}

describe("the per-Job read cache", () => {
  it("answers identical reads once, also while the first is in flight", async () => {
    const github = counting();
    const [a, b] = await Promise.all([
      github.client.request(route, repo),
      github.client.request(route, repo),
    ]);
    const c = await github.client.request(route, repo);
    const reads = [a, b, c].map(
      ({ data }) => (data as unknown as { reads: number }).reads,
    );
    assert.deepEqual(reads, [1, 1, 1]);
    await github.client.request(route, { ...repo, headers: {} });
    await github.client.request("GET /repos/{owner}/{repo}?x=1", repo);
    assert.equal(github.calls.length, 2);
  });

  it("gives every caller its own copy of the data", async () => {
    const github = counting();
    const first = await github.client.request(route, repo);
    (first.data as unknown as { nested: { list: number[] } }).nested.list.push(2);
    const second = await github.client.request(route, repo);
    assert.deepEqual((second.data as unknown as { nested: unknown }).nested, {
      list: [1],
    });
  });

  it("keeps paginated lists intact across repeated reads", async () => {
    const runs = [{ id: 1 }, { id: 2 }];
    const github = fakeGitHub({
      "GET /repos/acme/app/actions/runs": paged(runs, "workflow_runs"),
    });
    const list = () =>
      github.client.paginate("GET /repos/{owner}/{repo}/actions/runs", {
        ...repo,
        per_page: 100,
      });
    assert.deepEqual(await list(), runs);
    assert.deepEqual(await list(), runs);
    assert.equal(github.calls.length, 1);
  });

  it("reads again after any write, whatever its outcome", async () => {
    const github = counting();
    await github.client.request(route, repo);
    await github.client.request("POST /repos/{owner}/{repo}/issues", {
      ...repo,
      title: "x",
    });
    assert.equal(await readCount(github), 2);
    await rejection(
      github.client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        ...repo,
        issue_number: 1,
      }),
    );
    assert.equal(await readCount(github), 3);
  });

  it("does not keep a read answered while a write was sent", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const github = fakeGitHub({
      "GET /repos/acme/app": async () => {
        reads += 1;
        await gate;
        return { data: { reads } };
      },
      "POST /repos/acme/app/issues": { status: 201, data: {} },
    });
    const pending = github.client.request(route, repo);
    await new Promise((resolve) => setImmediate(resolve));
    await github.client.request("POST /repos/{owner}/{repo}/issues", {
      ...repo,
      title: "x",
    });
    release();
    await pending;
    await github.client.request(route, repo);
    assert.equal(reads, 2);
  });

  it("does not keep failed reads", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": sequence(failure(404), { data: { ok: true } }),
    });
    await rejection(github.client.request(route, repo));
    assert.deepEqual((await github.client.request(route, repo)).data, { ok: true });
  });

  it("keys GraphQL queries by their body and treats mutations as writes", async () => {
    const github = counting();
    const query = (text: string) =>
      github.client.request("POST /graphql", { query: text });
    await query("query { a }");
    await query("query { a }");
    await query("query { b }");
    assert.equal(github.calls.length, 2);
    await query("mutation { c }");
    await query("query { a }");
    assert.equal(github.calls.length, 4);
  });

  it("reads fresh after freshReads, also through a sharing wrapper", async () => {
    const github = counting();
    const wrapper = shareReadCache({ ...github.client }, github.client);
    await github.client.request(route, repo);
    freshReads(wrapper);
    assert.equal(await readCount(github), 2);
    freshReads(github.client);
    assert.equal(await readCount(github), 3);
    // Objects without a cache are left alone.
    const plain = {};
    assert.equal(shareReadCache(plain, {}), plain);
    freshReads(plain);
  });
});

describe("isReadRequest", () => {
  it("counts GET, HEAD and GraphQL queries as reads", () => {
    const api = "https://api.github.com";
    assert.equal(isReadRequest("GET", `${api}/repos/a/b`), true);
    assert.equal(isReadRequest("HEAD", `${api}/repos/a/b`), true);
    assert.equal(isReadRequest("POST", `${api}/graphql`, { query: "query { a }" }), true);
    assert.equal(isReadRequest("POST", "/graphql", {}), true);
    assert.equal(isReadRequest("POST", "/graphql", { query: " mutation { a }" }), false);
    assert.equal(isReadRequest("POST", `${api}/repos/a/b/issues`), false);
    assert.equal(isReadRequest("PUT", `${api}/graphql`), false);
  });
});
