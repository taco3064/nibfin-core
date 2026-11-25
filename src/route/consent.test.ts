import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, rejection } from "../github/fake-github.test.ts";
import { type Actor, GitHubError } from "../github/index.ts";
import { fakeIssue, fakeIssues, seedComment } from "../stages/fake-job.test.ts";
import { askForConsent, consentBody, consentCommentKey } from "./consent.ts";
import { fakeRunner } from "./fake-runner.test.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const owner = { id: 5, login: "taco" };
const ann = { id: 7, login: "ann" };
const bob = { id: 8, login: "bob" };

/** An Issue with `assignees` and `labels` on a fake GitHub, its runner owned by 5. */
function world(assignees: Actor[], labels = ["scope", "shaped"]) {
  const issues = fakeIssues(fakeIssue({ assignees, labels }));
  const runner = fakeRunner(issues.github);
  return { issues, runner, ask: () => askForConsent(runner.scope, issue, assignees) };
}

function markAsked(issues: ReturnType<typeof world>["issues"], user: Actor) {
  const key = consentCommentKey(user.id);
  seedComment(issues, issues.main, `<!-- nibfin:${key} -->\n${consentBody(user.login)}`);
}

/** The writes in order, as `<method> <last path segment>`. */
function writeOrder(issues: ReturnType<typeof world>["issues"]) {
  return issues.github
    .writes()
    .map((call) => `${call.method} ${call.path.split("/").at(-1)}`);
}

describe("askForConsent", () => {
  it("asks nobody and reads no comments when only the owner is assigned", async () => {
    const { issues, runner, ask } = world([owner]);
    assert.equal(await ask(), false);
    assert.deepEqual(issues.github.writes(), []);
    assert.ok(!issues.github.calls.some((call) => call.path === "/graphql"));
    assert.deepEqual(runner.logs, []);
  });

  it("adds pause, then asks a collaborator in a marked comment", async () => {
    const { issues, runner, ask } = world([owner, ann]);
    assert.equal(await ask(), true);
    assert.deepEqual(writeOrder(issues), ["POST labels", "POST comments"]);
    assert.ok(issues.main.labels.includes("pause"));
    const [comment] = issues.marked("consent-7");
    assert.ok(comment !== undefined);
    assert.match(comment.body, /^<!-- nibfin:consent-7 -->\n@ann, /);
    assert.match(comment.body, /remove the `pause` label to start/);
    assert.match(comment.body, /consent step, not a security control/);
    assert.equal(issues.marked("consent-5").length, 0);
    assert.deepEqual(runner.logs, [
      "acme/app#1: added pause for the consent of Assignee(s) 7; nothing dispatched",
    ]);
  });

  it("asks two collaborators in Assignee order", async () => {
    const { issues, runner, ask } = world([bob, owner, ann]);
    assert.equal(await ask(), true);
    const comments = issues.main.comments.map((comment) => comment.body.split("\n")[0]);
    assert.deepEqual(comments, [
      "<!-- nibfin:consent-8 -->",
      "<!-- nibfin:consent-7 -->",
    ]);
    assert.match(runner.logs[0], /Assignee\(s\) 8, 7;/);
  });

  it("writes nothing for a collaborator already asked", async () => {
    const { issues, ask } = world([owner, ann]);
    markAsked(issues, ann);
    assert.equal(await ask(), false);
    assert.deepEqual(issues.github.writes(), []);
    assert.ok(!issues.main.labels.includes("pause"));
  });

  it("asks only the new collaborator when another was asked", async () => {
    const { issues, runner, ask } = world([ann, bob]);
    markAsked(issues, ann);
    assert.equal(await ask(), true);
    assert.ok(issues.main.labels.includes("pause"));
    assert.equal(issues.marked("consent-7").length, 1);
    assert.equal(issues.marked("consent-8").length, 1);
    assert.match(runner.logs[0], /Assignee\(s\) 8;/);
  });

  it("does not count a consent comment by another author", async () => {
    const { issues, ask } = world([ann]);
    seedComment(issues, issues.main, "<!-- nibfin:consent-7 -->\nForged.", 77);
    assert.equal(await ask(), true);
    assert.equal(issues.marked("consent-7").length, 1);
  });

  it("writes the comments without a label write when pause is present", async () => {
    const { issues, ask } = world([ann], ["scope", "pause"]);
    assert.equal(await ask(), true);
    assert.deepEqual(writeOrder(issues), ["POST comments"]);
  });

  it("writes only the missing comment after a partial run", async () => {
    const { issues, ask } = world([ann, bob], ["scope", "pause"]);
    markAsked(issues, ann);
    assert.equal(await ask(), true);
    assert.deepEqual(writeOrder(issues), ["POST comments"]);
    assert.equal(issues.marked("consent-7").length, 1);
    assert.equal(issues.marked("consent-8").length, 1);
  });

  it("fails unconfirmed and comments nothing when pause is not read back", async () => {
    const { issues, ask } = world([ann]);
    issues.github.routes.set("POST /repos/acme/app/issues/1/labels", { data: [] });
    const error = await rejection(ask());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.match(error.message, /add pause/);
    assert.deepEqual(issues.main.comments, []);
  });

  it("fails as a read when the owner cannot be read", async () => {
    const { issues, ask } = world([ann]);
    issues.github.routes.set("GET /repos/acme/runner", failure(404));
    const error = await rejection(ask());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.deepEqual(issues.github.writes(), []);
  });
});
