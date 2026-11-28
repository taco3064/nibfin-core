import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { failure, fakeGitHub, paged, rejection, repo } from "./fake-github.test.ts";
import {
  listIssueComments,
  readIssueComment,
  readLastUnlabeled,
} from "./issue-events.ts";

const issue = { ...repo, number: 3 };
const events = "GET /repos/acme/app/issues/3/events";
const comment = "GET /repos/acme/app/issues/comments/55";

const event = (kind: string, at: string, label?: string | null) => ({
  event: kind,
  created_at: at,
  ...(label === undefined ? {} : { label: label === null ? null : { name: label } }),
});

describe("readLastUnlabeled", () => {
  it("gives the latest removal of the label across every page", async () => {
    const items = [
      event("labeled", "2026-11-27T01:00:00Z", "pending"),
      event("unlabeled", "2026-11-27T02:00:00Z", "pending"),
      event("unlabeled", "2026-11-27T05:00:00Z", "scope"),
      event("closed", "2026-11-27T06:00:00Z"),
      event("unlabeled", "2026-11-27T06:30:00Z", null),
      ...Array.from({ length: 100 }, () => event("commented", "2026-11-27T07:00:00Z")),
      event("unlabeled", "2026-11-27T08:00:00Z", "pending"),
      event("unlabeled", "2026-11-27T03:00:00Z", "pending"),
    ];
    const github = fakeGitHub({ [events]: paged(items) });
    assert.equal(
      await readLastUnlabeled(github.client, issue, "pending"),
      "2026-11-27T08:00:00Z",
    );
    assert.equal(github.calls.length, 2);
    assert.equal(github.calls[0]?.query.get("per_page"), "100");
  });

  it("is null when the label was never removed", async () => {
    const github = fakeGitHub({ [events]: paged([event("labeled", "x", "pending")]) });
    assert.equal(await readLastUnlabeled(github.client, issue, "pending"), null);
  });

  it("fails when the events cannot be read", async () => {
    const github = fakeGitHub({ [events]: failure(404) });
    const error = await rejection(readLastUnlabeled(github.client, issue, "pending"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("readIssueComment", () => {
  it("reads the body, URL and update time", async () => {
    const data = {
      id: 55,
      body: "Hello",
      html_url: "https://github.com/acme/app/issues/3#issuecomment-55",
      updated_at: "2026-11-27T01:00:00Z",
    };
    const github = fakeGitHub({ [comment]: { data } });
    assert.deepEqual(await readIssueComment(github.client, repo, 55), {
      id: 55,
      body: "Hello",
      url: data.html_url,
      updatedAt: data.updated_at,
    });
  });

  it("reads an empty body and fails when the comment cannot be read", async () => {
    const github = fakeGitHub({
      [comment]: { data: { id: 55, body: null, html_url: "u", updated_at: "t" } },
    });
    assert.equal((await readIssueComment(github.client, repo, 55)).body, "");
    const missing = await rejection(readIssueComment(github.client, repo, 56));
    assert.ok(missing instanceof GitHubError);
    const error = await rejection(
      readIssueComment(github.client, { owner: "acme", repo: "other" }, 55),
    );
    assert.ok(error instanceof GitHubError);
  });
});

describe("listIssueComments", () => {
  const list = "GET /repos/acme/app/issues/3/comments";
  const item = (id: number, login: string | null, body: string | null) => ({
    id,
    user: login === null ? null : { id: id + 1, login },
    body,
    created_at: "2026-11-27T01:00:00Z",
    html_url: `https://github.com/acme/app/issues/3#issuecomment-${id}`,
  });

  it("reads every page with logins, bodies and creation times", async () => {
    const items = [
      item(1, "ann", "2"),
      ...Array.from({ length: 100 }, (_, i) => item(10 + i, "bob", "chat")),
      item(500, null, null),
    ];
    const github = fakeGitHub({ [list]: paged(items) });
    const comments = await listIssueComments(github.client, issue);
    assert.equal(comments.length, 102);
    assert.deepEqual(comments[0], {
      id: 1,
      login: "ann",
      body: "2",
      createdAt: "2026-11-27T01:00:00Z",
      url: "https://github.com/acme/app/issues/3#issuecomment-1",
    });
    assert.deepEqual(comments.at(-1), {
      id: 500,
      login: null,
      body: "",
      createdAt: "2026-11-27T01:00:00Z",
      url: "https://github.com/acme/app/issues/3#issuecomment-500",
    });
    assert.equal(github.calls[0]?.query.get("per_page"), "100");
  });

  it("fails when the comments cannot be read", async () => {
    const github = fakeGitHub({ [list]: failure(500) });
    const error = await rejection(listIssueComments(github.client, issue));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});
