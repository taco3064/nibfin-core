import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { paged, rejection } from "../github/fake-github.test.ts";
import { issue as issueJson } from "../github/fixtures.test.ts";
import { freshReads, GitHubError } from "../github/index.ts";
import { parseChoice, readLiveDecision, saveChoice } from "./choice.ts";
import { StageError } from "./errors.ts";
import {
  commentUrl,
  decide,
  issueRef,
  permissions,
  writeOptionsRecord,
} from "./fake-choice.test.ts";
import {
  agentResult,
  type AgentStep,
  fakeDeps,
  fakeIssue,
  type FakeIssue,
  type FakeIssues,
  fakeIssues,
  jobContext,
  makeCommittedWorkspace,
  routeIssue,
  seedComment,
} from "./fake-job.test.ts";
import { runShapeStage } from "./shape.ts";

let workspace: string;
before(async () => {
  workspace = await makeCommittedWorkspace("shape-choice-");
});

const origin = "Origin: https://github.com/acme/app/issues/50";
const body = `The widget must exist.\n\n${origin}`;
const changed = `The widget must not exist.\n\n${origin}`;
const amend = (
  next: string | null,
  blockedBy: string[] = [],
  changeSummary = "Dropped the widget.",
) => agentResult({ outcome: "amend", body: next, blockedBy, changeSummary });
const ready = (shape: string) => agentResult({ outcome: "ready", shape });
const approved = agentResult({ outcome: "approved" });

const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];

/** The Issues of the latest `choiceWorld`, for agent steps that change them. */
let active: FakeIssues | undefined;
const current = () => active!;

/** acme/app#1 with an options record and a decision for option 2 by a writer. */
async function choiceWorld(
  steps: AgentStep[],
  labels: string[] = ["scope"],
  setup?: (issues: FakeIssues) => void | Promise<void>,
) {
  const main = fakeIssue({ labels, body });
  const issues = fakeIssues(main);
  active = issues;
  const { github } = issues;
  permissions(issues);
  github.routes.set("PATCH /repos/acme/app/issues/1", (request) => {
    main.body = (request.body as { body: string }).body;
    return { data: {} };
  });
  await setup?.(issues);
  await writeOptionsRecord(issues);
  const decision = decide(issues, 2);
  freshReads(github.client);
  const fake = fakeDeps(steps);
  const nextFile = join(await makeTempDir("shape-choice-next-"), "next.json");
  const context = { ...jobContext(workspace), nextFile };
  const before = github.writes().length;
  return {
    issues,
    main,
    fake,
    decision,
    run: () => runShapeStage(context, github.client, fake.deps),
    next: () => JSON.parse(readFileSync(nextFile, "utf8")) as unknown,
    writes: () =>
      github
        .writes()
        .slice(before)
        .map((call) => `${call.method} ${call.path}`),
    choice: () => parseChoice(issues.marked("choice")[0]?.body ?? ""),
    choiceBody: () => issues.marked("choice")[0]?.body ?? "",
    roles: () => fake.runs.map((run) => roleOf(run.prompt)),
  };
}

const seedShape = (issues: FakeIssues) =>
  void seedComment(issues, issues.main, "<!-- nibfin:shape -->\n## Plan\nOld plan.");

/** Routes acme/app#9 and the native Blocked by edge #1 ← #9. */
function routeBlocker(
  issues: FakeIssues,
  blocker: FakeIssue = fakeIssue({ number: 9, title: "Owner of X" }),
) {
  const { github, blockers, main } = issues;
  routeIssue(github, blocker, []);
  github.routes.set("GET /repos/acme/app/issues/9", () => ({
    data: {
      ...issueJson(9, {
        state: blocker.state,
        labels: blocker.labels,
        totalBlocking: blockers.includes(blocker) ? 1 : 0,
      }),
      title: blocker.title,
      body: blocker.body,
    },
  }));
  github.routes.set("POST /repos/acme/app/issues/1/dependencies/blocked_by", () => {
    blockers.push(blocker);
    return { status: 201, data: {} };
  });
  github.routes.set("GET /repos/acme/app/issues/9/dependencies/blocking", (request) =>
    paged(
      blockers.includes(blocker)
        ? [issueJson(main.number, { labels: main.labels, assignees: main.assignees })]
        : [],
    )(request),
  );
}

const choiceComment =
  /^(POST \/repos\/acme\/app\/issues\/1\/comments|PATCH .*comments\/\d+)$/;

describe("runShapeStage with a chosen option (R4.51)", () => {
  it("applies the option to an unshaped Issue, then shapes the result", async () => {
    const t = await choiceWorld([amend(changed), ready("## Plan\nNo widget."), approved]);
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, changed);
    assert.deepEqual(t.roles(), [
      "Shape Author (chosen option)",
      "Shape Author",
      "Shape Validator",
    ]);
    const [choiceRun, authorRun] = t.fake.runs;
    assert.match(choiceRun.prompt, /## Chosen option\n\nOption 2, chosen in https:/);
    assert.ok(choiceRun.prompt.includes(commentUrl(t.decision)));
    assert.ok(choiceRun.prompt.includes("2. **Drop the widget** (recommended)"));
    assert.ok(choiceRun.prompt.includes("Reason of the stop: The Issue leaves"));
    assert.ok(choiceRun.prompt.includes("The widget must exist."));
    assert.ok(authorRun.prompt.includes("The widget must not exist."));
    const writes = t.writes();
    assert.match(writes[0], choiceComment);
    assert.match(writes[1], choiceComment);
    assert.equal(writes[2], "PATCH /repos/acme/app/issues/1");
    assert.match(writes[3], choiceComment);
    assert.ok(writes.includes("POST /repos/acme/app/issues/1/labels"));
    assert.ok(t.main.labels.includes("shaped"));
    const choice = t.choice();
    assert.equal(choice?.status, "applied");
    assert.equal(choice?.comment, t.decision.id);
    assert.ok(t.choiceBody().includes("- Change: Dropped the widget.\n"));
    assert.ok(t.choiceBody().includes("- The Issue was changed as above.\n"));
    assert.ok(t.choiceBody().includes("by `user-7` in [this comment]"));
    assert.ok(t.fake.logs.includes("Applied option 2: Dropped the widget."));
  });

  it("does nothing again once the choice is applied", async () => {
    const t = await choiceWorld([amend(changed), ready("Plan"), approved]);
    await t.run();
    const writes = t.writes().length;
    freshReads(t.issues.github.client);
    assert.equal(await t.run(), 0);
    assert.equal(t.writes().length, writes);
    assert.equal(t.fake.runs.length, 3);
  });

  it("applies the empty change of an unshaped Issue, then shapes it", async () => {
    const t = await choiceWorld([amend(null), ready("Plan"), approved]);
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, body);
    assert.ok(!t.writes().includes("PATCH /repos/acme/app/issues/1"));
    assert.deepEqual(t.roles(), [
      "Shape Author (chosen option)",
      "Shape Author",
      "Shape Validator",
    ]);
    assert.ok(t.choiceBody().includes("- No Issue change.\n"));
  });

  it("removes shaped after changing a shaped Issue; publishing adds it", async () => {
    const t = await choiceWorld(
      [amend(changed), approved],
      ["scope", "shaped"],
      seedShape,
    );
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, changed);
    assert.deepEqual(t.roles(), ["Shape Author (chosen option)", "Shape Validator"]);
    const writes = t.writes();
    const removed = writes.indexOf("DELETE /repos/acme/app/issues/1/labels/shaped");
    const added = writes.indexOf("POST /repos/acme/app/issues/1/labels");
    assert.ok(writes.indexOf("PATCH /repos/acme/app/issues/1") < removed);
    assert.ok(removed < added);
    assert.ok(t.main.labels.includes("shaped"));
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
  });

  it("keeps a shaped Issue the option left as it was, with no Shape round", async () => {
    const t = await choiceWorld([amend(null)], ["scope", "shaped"], seedShape);
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.roles(), ["Shape Author (chosen option)"]);
    assert.ok(t.main.labels.includes("shaped"));
    assert.equal(t.main.body, body);
    assert.ok(!t.writes().some((write) => write.includes("/labels")));
    assert.ok(!t.writes().includes("PATCH /repos/acme/app/issues/1"));
    assert.equal(t.choice()?.status, "applied");
    assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
    assert.equal(
      t.fake.logs.at(-1),
      "After the chosen option the Issue is at deliver; no Shape round",
    );
  });

  it("a body returned unchanged changes nothing", async () => {
    const t = await choiceWorld([amend(body)], ["scope", "shaped"], seedShape);
    assert.equal(await t.run(), 0);
    assert.ok(t.main.labels.includes("shaped"));
    assert.ok(t.choiceBody().includes("- No Issue change.\n"));
  });

  it("adds Blocked by edges and removes shaped for them", async () => {
    const url = "https://github.com/acme/app/issues/9";
    const t = await choiceWorld(
      [amend(null, [url]), approved],
      ["scope", "shaped"],
      (i) => {
        seedShape(i);
        routeBlocker(i);
      },
    );
    assert.equal(await t.run(), 0);
    assert.deepEqual(
      t.issues.blockers.map((item) => item.number),
      [9],
    );
    assert.ok(
      t.writes().includes("POST /repos/acme/app/issues/1/dependencies/blocked_by"),
    );
    assert.ok(t.writes().includes("DELETE /repos/acme/app/issues/1/labels/shaped"));
    assert.ok(t.choiceBody().includes(`- Blocked by to add: ${url}\n`));
  });

  it("drops the choice and stops when the choice role is blocked", async () => {
    const blocked = agentResult({ outcome: "blocked", reason: "The option is unclear." });
    const t = await choiceWorld([blocked]);
    const error = await rejection(t.run());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_BLOCKED");
    assert.equal(t.choice()?.status, "dropped");
    const why = "- Why: Shape Author (chosen option) returned blocked: ";
    assert.ok(t.choiceBody().includes(`${why}The option is unclear.\n`));
    const [report] = t.issues.marked("shape-blocked");
    assert.match(
      report.body,
      /Shape Author \(chosen option\)\)\.\n\nThe option is unclear/,
    );
    assert.equal(t.main.body, body);
  });

  for (const [name, change] of [
    ["paused", (main: FakeIssue) => void main.labels.push("pause")],
    ["closed", (main: FakeIssue) => void (main.state = "closed")],
    ["pending", (main: FakeIssue) => void main.labels.push("pending")],
  ] as const) {
    it(`writes nothing after the role when the Issue was ${name}`, async () => {
      const t = await choiceWorld([
        () => {
          change(current().main);
          return amend(changed);
        },
      ]);
      const writes = t.writes().length;
      assert.equal(await t.run(), 0);
      assert.equal(t.writes().length, writes + 1);
      assert.equal(t.choice()?.status, "chosen");
      assert.equal(t.main.body, body);
      assert.deepEqual(t.next(), { stage: null, reason: null, progressed: true });
    });
  }

  it("runs the role again when the Issue changed while it worked", async () => {
    const edited = `The widget must be blue.\n\n${origin}`;
    const t = await choiceWorld([
      () => {
        current().main.body = edited;
        return amend(changed);
      },
      amend(`The widget must not exist; not blue.\n\n${origin}`),
      ready("Plan"),
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, `The widget must not exist; not blue.\n\n${origin}`);
    assert.ok(t.fake.runs[1].prompt.includes("The widget must be blue."));
    assert.equal(t.roles()[1], "Shape Author (chosen option)");
  });

  it("applies a newer decision made while the role worked", async () => {
    let newer: ReturnType<typeof decide> | undefined;
    const t = await choiceWorld([
      () => {
        newer = decide(current(), 1);
        return amend(changed);
      },
      amend(null, [], "Kept the widget."),
      ready("Plan"),
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, body);
    assert.equal(t.choice()?.option, 1);
    assert.equal(t.choice()?.comment, newer?.id);
    assert.match(t.fake.runs[1].prompt, /Option 1, chosen in/);
  });

  it("drops a choice an earlier run left applying, and stops", async () => {
    const t = await choiceWorld([]);
    const live = await readLiveDecision(t.issues.github.client, issueRef);
    await saveChoice(t.issues.github.client, issueRef, live!, "applying");
    freshReads(t.issues.github.client);
    const error = await rejection(t.run());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_CHOICE_INTERRUPTED");
    assert.match(error.message, /may be partly applied/);
    assert.equal(t.choice()?.status, "dropped");
    assert.deepEqual(t.fake.runs, []);
  });

  for (const [name, result, reason] of [
    ["drops an Origin: line", amend("The widget must not exist."), /keep every Origin/],
    ["names a non-Issue URL", amend(null, ["https://example.com/x"]), /Issue URLs/],
  ] as const) {
    it(`rejects a result that ${name}`, async () => {
      const t = await choiceWorld([result]);
      const error = await rejection(t.run());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_RESULT_INVALID");
      assert.match(error.message, reason);
      assert.equal(t.choice()?.status, "chosen");
      assert.equal(t.main.body, body);
    });
  }

  it("redacts the token from what it writes", async () => {
    const t = await choiceWorld([
      amend(
        `${changed}\nghs_fakeTokenThatMustNeverBeLogged`,
        [],
        "ghs_fakeTokenThatMustNeverBeLogged",
      ),
      ready("Plan"),
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.doesNotMatch(t.main.body ?? "", /ghs_fake/);
    assert.doesNotMatch(t.choiceBody(), /ghs_fake/);
  });
});

describe("runShapeStage with a chosen option: edges and read-backs", () => {
  const url = "https://github.com/acme/app/issues/9";
  const closedBlocker = fakeIssue({
    number: 9,
    title: "Owner of X",
    state: "closed",
    labels: ["scope", "shaped", "delivered"],
  });

  it("skips an edge that already exists, keeping shaped", async () => {
    const t = await choiceWorld([amend(null, [url])], ["scope", "shaped"], (i) => {
      seedShape(i);
      routeBlocker(i, closedBlocker);
      i.blockers.push(closedBlocker);
    });
    assert.equal(await t.run(), 0);
    assert.ok(!t.writes().some((write) => write.includes("dependencies")));
    assert.ok(t.main.labels.includes("shaped"));
    assert.ok(t.choiceBody().includes("- No Issue change.\n"));
  });

  it("runs the role again when Blocked by changed while it worked", async () => {
    const t = await choiceWorld(
      [
        () => {
          current().blockers.push(closedBlocker);
          return amend(changed);
        },
        amend(changed),
        ready("Plan"),
        approved,
      ],
      ["scope"],
      (i) => routeBlocker(i, closedBlocker),
    );
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.roles().slice(0, 2), [
      "Shape Author (chosen option)",
      "Shape Author (chosen option)",
    ]);
    assert.ok(t.fake.runs[1].prompt.includes("Owner of X"));
    assert.equal(t.main.body, changed);
  });

  it("applies nothing when the choice stopped being pending meanwhile", async () => {
    const t = await choiceWorld([
      () => {
        const [stored] = current().marked("choice");
        stored.body = stored.body.replace("status=chosen", "status=applied");
        return amend(changed);
      },
      ready("Plan"),
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.main.body, body);
    assert.ok(t.fake.logs.includes("The choice is no longer pending; nothing to apply"));
    assert.deepEqual(t.roles().slice(1), ["Shape Author", "Shape Validator"]);
  });

  it("fails unconfirmed when shaped stays after its removal", async () => {
    const t = await choiceWorld([amend(changed)], ["scope", "shaped"], seedShape);
    t.issues.github.routes.set("DELETE /repos/acme/app/issues/1/labels/shaped", () => ({
      data: t.main.labels.map((name) => ({ name })),
    }));
    const error = await rejection(t.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(t.choice()?.status, "applying");
  });
});

describe("runShapeStage without a decision (R4.52)", () => {
  it("shapes as before when nobody chose an option", async () => {
    const issues = fakeIssues(fakeIssue({ body }));
    permissions(issues);
    await writeOptionsRecord(issues);
    decide(issues, "Which is better?");
    const fake = fakeDeps([ready("Plan"), approved]);
    assert.equal(
      await runShapeStage(jobContext(workspace), issues.github.client, fake.deps),
      0,
    );
    assert.deepEqual(
      fake.runs.map((run) => roleOf(run.prompt)),
      ["Shape Author", "Shape Validator"],
    );
    assert.deepEqual(issues.marked("choice"), []);
  });

  it("does nothing for a shaped Issue whose decision is by a non-writer", async () => {
    const issues = fakeIssues(fakeIssue({ labels: ["scope", "shaped"], body }));
    permissions(issues, { 7: "read" });
    await writeOptionsRecord(issues);
    decide(issues, 2);
    const fake = fakeDeps([]);
    const before = issues.github.writes().length;
    assert.equal(
      await runShapeStage(jobContext(workspace), issues.github.client, fake.deps),
      0,
    );
    assert.equal(issues.github.writes().length, before);
    assert.deepEqual(fake.logs, ["acme/app#1 is not at the shape stage: deliver"]);
  });
});
