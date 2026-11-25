import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import {
  freshReads,
  GitHubError,
  type MarkedComment,
  type Stage,
} from "../github/index.ts";
import { fakeIssue, fakeIssues, seedComment } from "./fake-job.test.ts";
import {
  parseShapeWrong,
  readCurrentShape,
  readPendingReport,
  removeShaped,
  reportShapeWrong,
  resolveShapeWrong,
  shapeNextAction,
  shapeWrongBody,
} from "./shape-wrong.ts";

const issue = { owner: "acme", repo: "app", number: 1 };
const marker = "<!-- nibfin:shape-wrong -->";

function comment(body: string): MarkedComment {
  return { id: 3, body: `${marker}\n${body}`, url: "https://example.invalid/c3" };
}

const reported = shapeWrongBody("10.2", "The Shape drops the CLI.");
const resolved =
  "Resolved: a rewritten Shape was approved and written.\n" +
  `Rewritten as Shape version: 10.3\n\n${reported}`;

describe("parseShapeWrong", () => {
  it("is pending while unresolved for the current version", () => {
    const { report, problem } = parseShapeWrong(comment(reported), "10.2");
    assert.equal(problem, undefined);
    assert.deepEqual(
      [report.unresolved, report.pending, report.active, report.rewrittenAs],
      [true, true, true, undefined],
    );
    assert.equal(report.reason, "The Shape drops the CLI.");
    assert.equal(report.original, reported);
  });

  it("is active but not pending once the Shape version moved on", () => {
    const { report } = parseShapeWrong(comment(reported), "10.3");
    assert.deepEqual([report.pending, report.active], [false, true]);
  });

  it("stays active when resolved by the current version only", () => {
    const now = parseShapeWrong(comment(resolved), "10.3").report;
    assert.deepEqual(
      [now.unresolved, now.pending, now.active, now.rewrittenAs],
      [false, false, true, "10.3"],
    );
    assert.equal(now.original, reported);
    assert.equal(now.reason, "The Shape drops the CLI.");
    const later = parseShapeWrong(comment(resolved), "10.4").report;
    assert.equal(later.active, false);
  });

  for (const [name, body, current, problem] of [
    ["a missing version line", "The approved Shape is wrong.\n\nWhy", "1.1", "valid"],
    ["a malformed version", "Title\nShape version: v2\n\nWhy", "1.1", "valid"],
    ["a single line", "Title", "1.1", "valid"],
    ["no current Shape", reported, undefined, "no current Shape"],
  ] as const) {
    it(`is neither pending nor active with ${name}`, () => {
      const parsed = parseShapeWrong(comment(body), current);
      assert.match(parsed.problem!, new RegExp(problem));
      assert.deepEqual([parsed.report.pending, parsed.report.active], [false, false]);
      assert.equal(parsed.report.unresolved, true);
    });
  }

  it("is not active when resolved with a malformed rewrite line", () => {
    const body = `Resolved: done\nRewritten as: 10.3\n\n${reported}`;
    const { report } = parseShapeWrong(comment(body), "10.3");
    assert.deepEqual([report.unresolved, report.active], [false, false]);
    const bare = parseShapeWrong(comment("Resolved: done"), "10.3").report;
    assert.deepEqual([bare.active, bare.reason], [false, ""]);
  });
});

describe("readCurrentShape", () => {
  it("reads the text and a version that changes only with the body", async () => {
    const issues = fakeIssues(fakeIssue());
    const { client } = issues.github;
    assert.equal(await readCurrentShape(client, issue), undefined);
    const shape = seedComment(issues, issues.main, "<!-- nibfin:shape -->\nPlan");
    // The comment was added outside this client: only a fresh read sees it.
    assert.equal(await readCurrentShape(client, issue), undefined);
    freshReads(client);
    const first = await readCurrentShape(client, issue);
    assert.deepEqual(first, {
      body: "<!-- nibfin:shape -->\nPlan",
      text: "Plan",
      version: `${shape.id}.1`,
    });
    const path = `/repos/acme/app/issues/comments/${shape.id}`;
    const patch = issues.github.routes.get(`PATCH ${path}`) as (r: unknown) => unknown;
    patch({ body: { body: shape.body } });
    freshReads(client);
    assert.equal((await readCurrentShape(client, issue))?.version, `${shape.id}.1`);
    patch({ body: { body: "<!-- nibfin:shape -->\nPlan 2" } });
    freshReads(client);
    const second = await readCurrentShape(client, issue);
    assert.deepEqual([second?.text, second?.version], ["Plan 2", `${shape.id}.2`]);
    // One Issue-record query per fresh read, no other request.
    const graphql = issues.github.calls.filter((call) => call.path === "/graphql");
    assert.equal(graphql.length, 4);
    assert.equal(issues.github.calls.length, 4);
  });

  it("finds a pending report against the current Shape only", async () => {
    const issues = fakeIssues(fakeIssue());
    const { client } = issues.github;
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const shape = seedComment(issues, issues.main, "<!-- nibfin:shape -->\nPlan");
    assert.equal(await readPendingReport(client, issue, log), undefined);
    // Each change below happens outside this client, so a fresh read follows it.
    seedComment(issues, issues.main, `${marker}\n${shapeWrongBody("1.1", "Why")}`);
    freshReads(client);
    assert.equal(await readPendingReport(client, issue, log), undefined);
    issues.main.comments.at(-1)!.body =
      `${marker}\n${shapeWrongBody(`${shape.id}.1`, "W")}`;
    freshReads(client);
    assert.equal((await readPendingReport(client, issue, log))?.reason, "W");
    issues.main.comments.splice(0, 1);
    freshReads(client);
    assert.equal(await readPendingReport(client, issue, log), undefined);
    assert.match(logs.at(-1)!, /has no current Shape to compare with; ignoring it$/);
  });
});

describe("report writes", () => {
  it("writes, resolves and re-resolves one report", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
    const { client } = issues.github;
    const written = await reportShapeWrong(client, issue, "5.1", "Why");
    assert.equal(written.body, `${marker}\n${shapeWrongBody("5.1", "Why")}`);
    const first = parseShapeWrong(written, "5.1").report;
    await resolveShapeWrong(client, issue, first, "5.2");
    const [stored] = issues.marked("shape-wrong");
    assert.equal(
      stored.body,
      `${marker}\nResolved: a rewritten Shape was approved and written.\n` +
        `Rewritten as Shape version: 5.2\n\n${shapeWrongBody("5.1", "Why")}`,
    );
    const again = parseShapeWrong({ ...written, body: stored.body }, "5.2").report;
    await resolveShapeWrong(client, issue, again, "5.3");
    assert.match(issues.marked("shape-wrong")[0].body, /version: 5\.3\n\nThe approved/);
    assert.equal(issues.marked("shape-wrong").length, 1);
  });

  it("fails unconfirmed when the resolved report reads back differently", async () => {
    const issues = fakeIssues(fakeIssue());
    const { client } = issues.github;
    const written = await reportShapeWrong(client, issue, "5.1", "Why");
    const path = `PATCH /repos/acme/app/issues/comments/${written.id}`;
    issues.github.routes.set(path, () => ({ data: {} }));
    const report = parseShapeWrong(written, "5.1").report;
    const error = await rejection(resolveShapeWrong(client, issue, report, "5.2"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
  });

  it("removes shaped and fails unconfirmed when it reads back", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope", "shaped"] }));
    const { client } = issues.github;
    await removeShaped(client, issue);
    assert.deepEqual(issues.main.labels, ["scope"]);
    await removeShaped(client, issue);
    issues.main.labels.push("shaped");
    freshReads(client);
    issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/shaped", {
      data: [],
    });
    const error = await rejection(removeShaped(client, issue));
    assert.equal((error as GitHubError).code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal((error as GitHubError).operation, "remove shaped");
  });
});

describe("shapeNextAction", () => {
  const pull = {} as never;
  const cases: Array<[Stage, unknown]> = [
    [
      { stage: "deliver", branch: "nibfin/issue-1" },
      { stage: "deliver", reason: null },
    ],
    [
      { stage: "deliver", branch: "nibfin/issue-1-cd-2" },
      { stage: "deliver", reason: "cd-failure" },
    ],
    [
      {
        stage: "ci-failed",
        branch: "b",
        pullRequest: pull,
        requiredChecks: [],
        results: [],
      },
      { stage: "deliver", reason: "ci-failure" },
    ],
    [
      {
        stage: "review",
        branch: "b",
        pullRequest: pull,
        requiredChecks: [],
        results: [],
      },
      { stage: "review", reason: null },
    ],
    [
      { stage: "conflict", branch: "b", pullRequest: pull },
      { stage: "deliver", reason: "conflict" },
    ],
    [
      {
        stage: "cd-failed",
        branch: "b",
        pullRequest: pull,
        runs: [],
        nextFixBranch: "c",
      },
      { stage: "deliver", reason: "cd-failure" },
    ],
    [
      { stage: "done", branch: "b", pullRequest: pull },
      { stage: "review", reason: null },
    ],
    [
      {
        stage: "awaiting-cd",
        reason: "cd-runs-pending",
        branch: "b",
        pullRequest: pull,
        runs: [],
      },
      { stage: null, reason: null },
    ],
    [
      {
        stage: "awaiting-ci",
        branch: "b",
        pullRequest: pull,
        requiredChecks: [],
        results: [],
      },
      { stage: null, reason: null },
    ],
    [{ stage: "shape" }, { stage: null, reason: null }],
    [
      { stage: "ineligible", reason: "paused" },
      { stage: null, reason: null },
    ],
  ];
  for (const [stage, expected] of cases) {
    const name = "branch" in stage ? `${stage.stage} on ${stage.branch}` : stage.stage;
    it(`maps ${name}`, () => {
      assert.deepEqual(shapeNextAction(stage, 1), expected);
    });
  }
});
