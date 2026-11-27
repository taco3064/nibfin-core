import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeActor, rejection } from "./fake-github.test.ts";
import { operationOf } from "./fake-issue-record.test.ts";
import { fakeWorld, keyOf } from "./fake-world.test.ts";
import {
  addAssignees,
  addBlockedBy,
  createIssue,
  findCreatedIssue,
  readIssueId,
} from "./issue-writes.ts";

const lib = { owner: "acme", repo: "lib" };

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(error.code, code);
  return error;
}

describe("readIssueId", () => {
  it("reads the REST id and GitHub's URL", async () => {
    const world = fakeWorld();
    const issue = world.add({ repo: "lib", number: 3 });
    const handle = await readIssueId(world.github.client, { ...lib, number: 3 });
    assert.deepEqual(handle, {
      ref: { ...lib, number: 3 },
      url: "https://github.com/acme/lib/issues/3",
      id: issue.id,
    });
  });

  it("fails for a pull request", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 3, pullRequest: true });
    await expectCode(
      readIssueId(world.github.client, { ...lib, number: 3 }),
      "GITHUB_READ_FAILED",
    );
  });
});

describe("createIssue", () => {
  const text = {
    title: "Add X",
    body: "Body\n\nOrigin: https://github.com/acme/app/issues/1",
  };

  it("creates an Issue with title and body only", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    const handle = await createIssue(world.github.client, lib, text);
    assert.equal(handle.url, "https://github.com/acme/lib/issues/2");
    const created = world.get("acme/lib#2");
    assert.equal(handle.id, created.id);
    assert.deepEqual(
      [created.title, created.body, created.labels],
      [text.title, text.body, []],
    );
    const [post] = world.github.writes();
    assert.deepEqual(post.body, text);
  });

  it("finds an Issue whose create had no response in the listing, not search", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    let lost = false;
    world.hook = (request, apply) => {
      if (
        request.method === "POST" &&
        request.path === "/repos/acme/lib/issues" &&
        !lost
      ) {
        lost = true;
        void apply();
        throw new TypeError("fetch failed");
      }
      return apply();
    };
    const handle = await createIssue(world.github.client, lib, text);
    assert.equal(handle.url, "https://github.com/acme/lib/issues/2");
    assert.equal(world.github.writes().length, 1);
    const listing = world.github.calls.find(
      (call) => call.method === "GET" && call.path === "/repos/acme/lib/issues",
    );
    assert.equal(listing?.query.get("creator"), fakeActor.login);
    assert.equal(listing?.query.get("state"), "all");
    assert.ok(!world.github.calls.some((call) => call.path.startsWith("/search")));
  });

  it("creates again when the listing shows no such Issue", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    let lost = false;
    world.hook = (request, apply) => {
      if (
        request.method === "POST" &&
        request.path === "/repos/acme/lib/issues" &&
        !lost
      ) {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return apply();
    };
    const handle = await createIssue(world.github.client, lib, text);
    assert.equal(handle.url, "https://github.com/acme/lib/issues/2");
    assert.equal(world.github.writes().length, 2);
  });
});

describe("findCreatedIssue", () => {
  it("skips pull requests, other creators and other text", async () => {
    const world = fakeWorld();
    world.add({
      repo: "lib",
      number: 1,
      title: "T",
      body: "B",
      creatorId: fakeActor.id,
      pullRequest: true,
    });
    world.add({ repo: "lib", number: 2, title: "T", body: "B" });
    world.add({
      repo: "lib",
      number: 3,
      title: "T",
      body: "other",
      creatorId: fakeActor.id,
    });
    const issue = world.add({
      repo: "lib",
      number: 4,
      title: "T",
      body: "B",
      creatorId: fakeActor.id,
    });
    world.add({ repo: "lib", number: 5, title: "U", body: "B", creatorId: fakeActor.id });
    const found = await findCreatedIssue(world.github.client, lib, "T", "B");
    assert.equal(found?.id, issue.id);
    assert.equal(await findCreatedIssue(world.github.client, lib, "T", "C"), undefined);
  });

  it("treats a missing body as empty", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1, title: "T", body: "", creatorId: fakeActor.id });
    world.github.routes.set("GET /repos/acme/lib/issues", {
      data: [{ id: 5, number: 1, title: "T", body: null, html_url: "u" }],
    });
    const found = await findCreatedIssue(world.github.client, lib, "T", "");
    assert.equal(found?.id, 5);
  });
});

describe("addBlockedBy", () => {
  function twoIssues() {
    const world = fakeWorld();
    const blocked = world.add({ repo: "lib", number: 1 });
    const blocker = world.add({ owner: "acme", repo: "app", number: 9 });
    const handles = {
      blocked: { ref: { ...lib, number: 1 }, url: world.url(blocked) },
      blocker: {
        ref: { owner: "acme", repo: "app", number: 9 },
        url: world.url(blocker),
        id: blocker.id,
      },
    };
    return { world, ...handles };
  }

  it("adds the edge by the blocker's REST id and reads both directions", async () => {
    const t = twoIssues();
    assert.equal(await addBlockedBy(t.world.github.client, t.blocked, t.blocker), true);
    assert.deepEqual(t.world.get("acme/lib#1").blockedBy, ["acme/app#9"]);
    const [post] = t.world.github.writes();
    assert.equal(post.path, "/repos/acme/lib/issues/1/dependencies/blocked_by");
    assert.deepEqual(post.body, { issue_id: t.blocker.id });
    const blocking = t.world.github.calls.find(
      (call) => operationOf(call.body) === "IssueBlocking",
    );
    assert.deepEqual((blocking?.body as { variables: unknown }).variables, {
      owner: "acme",
      repo: "app",
      number: 9,
    });
  });

  it("writes nothing for an edge already in place, in any URL case", async () => {
    const t = twoIssues();
    t.world.get("acme/lib#1").blockedBy.push(keyOf(t.blocker.ref));
    const upper = { ...t.blocker, url: t.blocker.url.replace("acme", "ACME") };
    assert.equal(await addBlockedBy(t.world.github.client, t.blocked, upper), false);
    assert.deepEqual(t.world.github.writes(), []);
  });

  it("recovers a 422 by reading the edge back", async () => {
    const t = twoIssues();
    t.world.hook = (request, apply) => {
      if (request.method === "POST") {
        void apply();
        return failure(422, "Dependency already exists");
      }
      return apply();
    };
    assert.equal(await addBlockedBy(t.world.github.client, t.blocked, t.blocker), true);
    assert.equal(t.world.github.writes().length, 1);
  });

  it("is rejected when a 4xx leaves no edge", async () => {
    const t = twoIssues();
    t.world.hook = (request, apply) =>
      request.method === "POST" ? failure(403, "Forbidden") : apply();
    await expectCode(
      addBlockedBy(t.world.github.client, t.blocked, t.blocker),
      "GITHUB_WRITE_REJECTED",
    );
    assert.deepEqual(t.world.get("acme/lib#1").blockedBy, []);
  });

  it("is unconfirmed when the reverse direction does not read back", async () => {
    const t = twoIssues();
    t.world.github.routes.set("GET /repos/acme/app/issues/9/dependencies/blocking", {
      data: [],
    });
    const error = await expectCode(
      addBlockedBy(t.world.github.client, t.blocked, t.blocker),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.match(
      error.message,
      /add https:\/\/github.com\/acme\/app\/issues\/9 as Blocked by/,
    );
  });

  it("is unconfirmed when the edge does not read back after a 201", async () => {
    const t = twoIssues();
    t.world.hook = (request, apply) =>
      request.method === "POST" ? { status: 201, data: {} } : apply();
    await expectCode(
      addBlockedBy(t.world.github.client, t.blocked, t.blocker),
      "GITHUB_WRITE_UNCONFIRMED",
    );
  });
});

describe("addAssignees", () => {
  it("posts only the missing logins and reads them back", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1, assignees: ["Taco"] });
    const issue = { ...lib, number: 1 };
    assert.equal(await addAssignees(world.github.client, issue, ["taco", "mika"]), true);
    assert.deepEqual(world.get("acme/lib#1").assignees, ["Taco", "mika"]);
    const [post] = world.github.writes();
    assert.deepEqual(post.body, { assignees: ["mika"] });
    assert.equal(await addAssignees(world.github.client, issue, ["taco", "mika"]), false);
    assert.equal(world.github.writes().length, 1);
  });

  it("confirms an assignment whose answer was a 502 without re-sending", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    world.hook = (request, apply) => {
      if (request.method === "POST") {
        void apply();
        return failure(502, "Bad Gateway");
      }
      return apply();
    };
    assert.equal(
      await addAssignees(world.github.client, { ...lib, number: 1 }, ["taco"]),
      true,
    );
    assert.equal(world.github.writes().length, 1);
    assert.deepEqual(world.get("acme/lib#1").assignees, ["taco"]);
  });

  it("sends again when a lost assignment did not take effect", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    let lost = false;
    world.hook = (request, apply) => {
      if (request.method === "POST" && !lost) {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return apply();
    };
    assert.equal(
      await addAssignees(world.github.client, { ...lib, number: 1 }, ["taco"]),
      true,
    );
    assert.equal(world.github.writes().length, 2);
  });

  it("is unconfirmed when GitHub silently ignores a login", async () => {
    const world = fakeWorld();
    world.add({ repo: "lib", number: 1 });
    world.ignoredAssignees.add("mika");
    const error = await expectCode(
      addAssignees(world.github.client, { ...lib, number: 1 }, ["taco", "mika"]),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.match(String((error.cause as Error).message), /did not assign mika/);
  });
});
