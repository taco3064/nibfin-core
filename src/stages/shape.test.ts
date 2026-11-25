import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { AgentError } from "../agent/index.ts";
import { ConfigError } from "../config/index.ts";
import { fakeActor, rejection } from "../github/fake-github.test.ts";
import { GitHubError } from "../github/index.ts";
import { StageError } from "./errors.ts";
import {
  agentResult,
  type AgentStep,
  fakeDeps,
  fakeIssue,
  type FakeIssue,
  fakeIssues,
  fakePathEntries,
  jobContext,
  makeCommittedWorkspace,
  seedComment,
} from "./fake-job.test.ts";
import { runShapeStage } from "./shape.ts";

let workspace: string;
before(async () => {
  workspace = await makeCommittedWorkspace("shape-");
});

const shapeMarker = "<!-- nibfin:shape -->";
const blockedMarker = "<!-- nibfin:shape-blocked -->";
const ready = (shape: string) => agentResult({ outcome: "ready", shape });
const approved = agentResult({ outcome: "approved" });
const changes = (...findings: string[]) =>
  agentResult({ outcome: "changes-required", findings });

function setup(
  steps: AgentStep[],
  main: FakeIssue = fakeIssue(),
  blockers: FakeIssue[] = [],
) {
  const issues = fakeIssues(main, blockers);
  const fake = fakeDeps(steps);
  const run = (model?: string) =>
    runShapeStage(jobContext(workspace, model), issues.github.client, fake.deps);
  return { issues, fake, run };
}

const roleOf = (prompt: string) => /Your role is ([^.]+)\./.exec(prompt)?.[1];

describe("runShapeStage eligibility", () => {
  for (const [name, main, expected] of [
    ["shaped", fakeIssue({ labels: ["scope", "shaped"] }), "deliver"],
    ["paused", fakeIssue({ labels: ["scope", "pause"] }), "ineligible (paused)"],
    ["closed", fakeIssue({ state: "closed" }), "ineligible (closed)"],
  ] as const) {
    it(`does nothing for a ${name} Issue`, async () => {
      const t = setup([], main);
      assert.equal(await t.run(), 0);
      assert.deepEqual(t.fake.logs, [
        `acme/app#1 is not at the shape stage: ${expected}`,
      ]);
      assert.deepEqual(t.fake.runs, []);
      assert.deepEqual(t.fake.configReads, []);
      assert.deepEqual(t.issues.github.writes(), []);
    });
  }

  it("rejects the Job on a ConfigError before any role runs", async () => {
    const t = setup([]);
    const error = new ConfigError("CONFIG_INVALID", ".nibfin.json is invalid");
    t.fake.deps.readNibfinConfig = () => Promise.reject(error);
    assert.equal(await rejection(t.run()), error);
    assert.deepEqual(t.fake.runs, []);
  });
});

describe("runShapeStage publication", () => {
  it("publishes a Shape the separate Validator approved, then shaped", async () => {
    const author = `Reasoning the Validator never sees.\n${ready("## Plan\r\nDo it.")}`;
    const t = setup([author, approved]);
    assert.equal(await t.run("sonnet"), 0);
    const [published] = t.issues.marked("shape");
    assert.equal(published?.body, `${shapeMarker}\n## Plan\nDo it.`);
    assert.equal(t.issues.marked("shape").length, 1);
    assert.ok(t.issues.main.labels.includes("shaped"));
    const [authorRun, validatorRun] = t.fake.runs;
    assert.equal(roleOf(authorRun.prompt), "Shape Author");
    assert.equal(roleOf(validatorRun.prompt), "Shape Validator");
    assert.match(authorRun.prompt, /^SKILL TEXT OF shape/);
    assert.match(authorRun.prompt, /The widget must exist\./);
    assert.match(validatorRun.prompt, /## Proposed Shape\n\n## Plan\nDo it\./);
    assert.doesNotMatch(validatorRun.prompt, /Reasoning the Validator never sees/);
    for (const run of t.fake.runs) {
      assert.deepEqual(run.pathEntries, fakePathEntries);
      assert.deepEqual(run.environment, {
        PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright",
      });
      assert.equal(run.model, "sonnet");
      assert.equal(run.home, "/login/claude");
      assert.equal(run.workspace, workspace);
      assert.doesNotMatch(run.prompt, /ghs_fake/);
    }
    assert.deepEqual(t.fake.configReads, [workspace]);
    assert.deepEqual(t.fake.toolPreparations, [
      { tools: { node: "22.15.0" }, cacheDir: "/cache" },
    ]);
    assert.deepEqual(t.fake.skillReads, ["shape", "shape"]);
    assert.deepEqual(t.fake.logs.slice(0, 2), [
      "Round 1: Shape Author",
      "Round 1: Shape Validator",
    ]);
    assert.match(t.fake.logs.at(-1)!, /^Published the Shape: https:/);
  });

  it("reads the Issue once before its first agent run", async () => {
    const seen: string[] = [];
    const t = setup([
      () => {
        seen.push(...t.issues.github.calls.map((call) => `${call.method} ${call.path}`));
        return ready("Plan");
      },
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.deepEqual(seen, ["POST /graphql"]);
  });

  it("does nothing when run again after publishing", async () => {
    const t = setup([ready("Plan"), approved]);
    await t.run();
    const writes = t.issues.github.writes().length;
    assert.equal(await t.run(), 0);
    assert.equal(t.issues.github.writes().length, writes);
    assert.equal(t.fake.runs.length, 2);
  });

  it("revises with the findings until a fresh Validator approves", async () => {
    const t = setup([ready("v1"), changes("Name the module"), ready("v2"), approved]);
    assert.equal(await t.run(), 0);
    assert.equal(t.issues.marked("shape")[0]?.body, `${shapeMarker}\nv2`);
    const revise = t.fake.runs[2].prompt;
    assert.equal(roleOf(revise), "Shape Author");
    assert.match(revise, /## Previous proposed Shape\n\nv1/);
    assert.match(revise, /## Validator findings\n\n- Name the module/);
    const first = t.fake.runs[1].prompt;
    assert.equal(roleOf(first), "Shape Validator");
    assert.doesNotMatch(first, /## Previous proposed Shape/);
    assert.doesNotMatch(first, /## Previous Validator findings/);
    const second = t.fake.runs[3].prompt;
    assert.equal(roleOf(second), "Shape Validator");
    assert.match(second, /## Proposed Shape\n\nv2/);
    assert.match(second, /## Previous proposed Shape\n\nv1/);
    assert.match(second, /## Previous Validator findings\n\n- Name the module/);
    assert.deepEqual(t.fake.logs.slice(0, 5), [
      "Round 1: Shape Author",
      "Round 1: Shape Validator",
      "Round 1: changes required\n- Name the module",
      "Round 2: Shape Author",
      "Round 2: Shape Validator",
    ]);
  });

  it("gives a revision-round Validator only the immediately previous round", async () => {
    const t = setup([
      ready("v1"),
      changes("First finding"),
      ready("v2"),
      changes("Second finding"),
      ready("v3"),
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.issues.marked("shape")[0]?.body, `${shapeMarker}\nv3`);
    const third = t.fake.runs[5].prompt;
    assert.equal(roleOf(third), "Shape Validator");
    assert.match(third, /## Proposed Shape\n\nv3/);
    assert.match(third, /## Previous proposed Shape\n\nv2/);
    assert.match(third, /## Previous Validator findings\n\n- Second finding/);
    assert.doesNotMatch(third, /\bv1\b/);
    assert.doesNotMatch(third, /First finding/);
  });

  it("validates an existing unpublished Shape before any Author run", async () => {
    const t = setup([approved]);
    seedComment(t.issues, t.issues.main, `${shapeMarker}\nThe old plan`, 7);
    seedComment(t.issues, t.issues.main, `${shapeMarker}\nExisting plan`);
    assert.equal(await t.run(), 0);
    assert.equal(roleOf(t.fake.runs[0].prompt), "Shape Validator");
    assert.match(t.fake.runs[0].prompt, /## Proposed Shape\n\nExisting plan/);
    const writes = t.issues.github.writes().map((call) => `${call.method} ${call.path}`);
    assert.deepEqual(writes, ["POST /repos/acme/app/issues/1/labels"]);
  });

  it("revises an existing Shape the Validator rejects", async () => {
    const t = setup([changes("Too vague"), ready("Precise plan"), approved]);
    seedComment(t.issues, t.issues.main, `${shapeMarker}\nVague plan`);
    assert.equal(await t.run(), 0);
    assert.match(t.fake.runs[1].prompt, /## Previous proposed Shape\n\nVague plan/);
    assert.equal(t.issues.marked("shape").length, 1);
    assert.equal(t.issues.marked("shape")[0]?.body, `${shapeMarker}\nPrecise plan`);
  });

  it("authors a new Shape when the marked comment is empty", async () => {
    const t = setup([ready("Plan"), approved]);
    seedComment(t.issues, t.issues.main, shapeMarker);
    assert.equal(await t.run(), 0);
    assert.equal(roleOf(t.fake.runs[0].prompt), "Shape Author");
    assert.equal(t.issues.marked("shape")[0]?.body, `${shapeMarker}\nPlan`);
  });

  it("marks an earlier blocked report resolved", async () => {
    const t = setup([ready("Plan"), approved]);
    seedComment(t.issues, t.issues.main, `${blockedMarker}\nThe Shape is blocked.`);
    assert.equal(await t.run(), 0);
    assert.equal(
      t.issues.marked("shape-blocked")[0]?.body,
      `${blockedMarker}\nResolved: the Shape was approved and published.`,
    );
  });
});

describe("runShapeStage stale state", () => {
  for (const [name, change] of [
    ["paused", (issue: FakeIssue) => issue.labels.push("pause")],
    ["closed", (issue: FakeIssue) => (issue.state = "closed")],
  ] as const) {
    it(`does not publish when the Issue was ${name} during the run`, async () => {
      const t = setup([
        ready("Plan"),
        () => {
          change(t.issues.main);
          return approved;
        },
      ]);
      assert.equal(await t.run(), 0);
      assert.deepEqual(t.issues.marked("shape"), []);
      assert.ok(!t.issues.main.labels.includes("shaped"));
      assert.match(t.fake.logs.at(-1)!, /is not at the shape stage: ineligible/);
    });
  }

  it("validates again against an Issue body edited during the run", async () => {
    const t = setup([
      ready("Plan"),
      (options) => {
        assert.match(options.prompt, /The widget must exist\./);
        t.issues.main.body = "The widget must be blue.";
        return approved;
      },
      (options) => {
        assert.match(options.prompt, /The widget must be blue\./);
        return approved;
      },
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.fake.runs.length, 3);
    assert.equal(roleOf(t.fake.runs[2].prompt), "Shape Validator");
    assert.ok(t.fake.logs.includes("Round 1: the Issue changed; validating again"));
    assert.equal(t.issues.marked("shape")[0]?.body, `${shapeMarker}\nPlan`);
  });

  it("validates again when the title changed", async () => {
    const t = setup([
      ready("Plan"),
      () => {
        t.issues.main.title = "Add the blue widget";
        return approved;
      },
      approved,
    ]);
    assert.equal(await t.run(), 0);
    assert.equal(t.fake.runs.length, 3);
  });
});

describe("runShapeStage blocked and invalid results", () => {
  for (const [role, steps] of [
    ["Shape Author", [agentResult({ outcome: "blocked", reason: "Needs Scope." })]],
    [
      "Shape Validator",
      [ready("Plan"), agentResult({ outcome: "blocked", reason: "Needs Scope." })],
    ],
  ] as const) {
    it(`reports a blocked ${role} on the Issue and stops`, async () => {
      const t = setup([...steps]);
      const error = await rejection(t.run());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_BLOCKED");
      assert.match(error.message, new RegExp(`^${role} returned blocked`));
      assert.equal(
        t.issues.marked("shape-blocked")[0]?.body,
        `${blockedMarker}\nThe Shape is blocked (${role}).\n\nNeeds Scope.`,
      );
      assert.deepEqual(t.issues.marked("shape"), []);
      assert.ok(!t.issues.main.labels.includes("shaped"));
    });
  }

  for (const [name, message] of [
    ["no result block", "I am done."],
    ["a marker-prefixed shape", ready("<!-- nibfin:shape -->\nPlan")],
    ["an empty shape", ready("  ")],
    ["a blocked result without reason", agentResult({ outcome: "blocked" })],
  ]) {
    it(`stops on an Author result with ${name}`, async () => {
      const t = setup([message]);
      const error = await rejection(t.run());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_RESULT_INVALID");
      assert.ok(error.message.includes(message));
      assert.deepEqual(t.issues.github.writes(), []);
    });
  }

  for (const [name, verdict] of [
    ["no findings", { outcome: "changes-required", findings: [] }],
    ["a blank finding", { outcome: "changes-required", findings: ["ok", " "] }],
    ["findings that are not a list", { outcome: "changes-required", findings: "x" }],
    ["an unknown outcome", { outcome: "ready", shape: "x" }],
  ] as const) {
    it(`stops on a Validator result with ${name}`, async () => {
      const t = setup([ready("Plan"), agentResult(verdict)]);
      const error = await rejection(t.run());
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_RESULT_INVALID");
      assert.deepEqual(t.issues.github.writes(), []);
    });
  }
});

describe("runShapeStage workspace and login", () => {
  it("stops when a read-only role changes the workspace", async () => {
    const t = setup([
      async (options) => {
        await writeFile(join(options.workspace, "notes.md"), "leftover");
        return ready("Plan");
      },
    ]);
    const error = await rejection(t.run());
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_WORKSPACE_MODIFIED");
    assert.equal(error.message, "Shape Author changed the workspace:\n+ ?? notes.md");
    assert.deepEqual(t.issues.marked("shape"), []);
    execFileSync("git", ["clean", "-fdq"], { cwd: workspace });
  });

  it("asks for a new login on the Issue, then marks it resolved", async () => {
    const login = new AgentError("AGENT_LOGIN_REQUIRED", "Claude Code login expired", {
      exitCode: 1,
      loginCommand: "gh nibfin login --provider claude",
    });
    const t = setup([login, ready("Plan"), approved]);
    assert.equal(await rejection(t.run()), login);
    const [comment] = t.issues.marked("agent-login");
    assert.match(comment.body, /the Claude Code login is missing or expired/);
    assert.match(comment.body, /Run `gh nibfin login --provider claude` on the runner/);
    assert.deepEqual(t.issues.marked("shape"), []);
    assert.equal(await t.run(), 0);
    assert.equal(
      t.issues.marked("agent-login")[0]?.body,
      "<!-- nibfin:agent-login -->\nResolved: the agent login works again.",
    );
    assert.equal(t.issues.marked("agent-login").length, 1);
  });
});

describe("runShapeStage sources and read-back", () => {
  it("gives both roles the Blocked by Issues and their Shapes", async () => {
    const delivered: Partial<FakeIssue> = {
      state: "closed",
      labels: ["scope", "shaped", "delivered"],
    };
    const local = fakeIssue({ number: 2, title: "Base", body: null, ...delivered });
    const external = fakeIssue({
      owner: "acme",
      repo: "lib",
      number: 9,
      title: "Lib",
      body: "Lib body",
      ...delivered,
    });
    const t = setup([ready("Plan"), approved], fakeIssue(), [local, external]);
    seedComment(t.issues, external, `${shapeMarker}\nLib plan`);
    seedComment(t.issues, external, `${shapeMarker}\nForeign plan`, fakeActor.id + 1);
    assert.equal(await t.run(), 0);
    for (const run of t.fake.runs) {
      const { prompt } = run;
      assert.match(prompt, /## Blocked by https:\/\/github.com\/acme\/app\/issues\/2/);
      assert.match(prompt, /Title: Base\n\n\(no description\)/);
      assert.match(prompt, /### Its published Shape\n\n\(none published by Nibfin\)/);
      assert.match(prompt, /## Blocked by https:\/\/github.com\/acme\/lib\/issues\/9/);
      assert.match(prompt, /another repository, so its delivered source is not/);
      assert.match(prompt, /### Its published Shape\n\nLib plan/);
      assert.doesNotMatch(prompt, /Foreign plan/);
      assert.equal(prompt.match(/another repository/g)?.length, 1);
    }
  });

  it("fails unconfirmed when the published comment reads back differently", async () => {
    const t = setup([ready("Plan"), approved]);
    const route = "POST /repos/acme/app/issues/1/comments";
    const post = t.issues.github.routes.get(route) as (request: never) => unknown;
    t.issues.github.routes.set(route, (request) => {
      (request.body as { body: string }).body += "\nedited";
      return post(request as never) as never;
    });
    const error = await rejection(t.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(error.operation, "publish the Shape");
  });

  it("fails unconfirmed when shaped does not read back", async () => {
    const t = setup([ready("Plan"), approved]);
    t.issues.github.routes.set("POST /repos/acme/app/issues/1/labels", { data: [] });
    const error = await rejection(t.run());
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(error.operation, "add shaped");
  });
});
