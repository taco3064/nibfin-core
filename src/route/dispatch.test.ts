import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failure,
  fakeGitHub,
  networkError,
  rejection,
} from "../github/fake-github.test.ts";
import {
  type Actor,
  freshReads,
  GitHubError,
  notStartedStatuses,
} from "../github/index.ts";
import { fakeIssue, fakeIssues, seedComment } from "../stages/fake-job.test.ts";
import {
  chooseAssignee,
  dispatchRoute,
  dispatchStage,
  planDispatch,
  repairDispatcher,
  sharedRunnerWorkflow,
} from "./dispatch.ts";
import { dispatchPath, fakeRunner, selfHostedRunner } from "./fake-runner.test.ts";

const repo = { owner: "acme", repo: "app" };
const taco = { id: 5, login: "taco" };
const deliver = {
  stage: "deliver" as const,
  reason: "ci-failure" as const,
  assignees: [taco],
};
const title = "Nibfin · acme/app#1 · deliver";
const online5 = "acme/app#1: Assignee 5 has an online runner";

describe("dispatchStage", () => {
  it("dispatches the stage on the default branch with its inputs", async () => {
    const runner = fakeRunner(fakeGitHub());
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    assert.equal(sharedRunnerWorkflow, "nibfin-shared-runner.yml");
    assert.deepEqual(runner.requests[0].body, {
      ref: "main",
      inputs: {
        stage: "deliver",
        repo: "acme/app",
        issue: "1",
        reason: "ci-failure",
        assignee: "5",
      },
      return_run_details: true,
    });
    assert.deepEqual(runner.logs, [
      online5,
      `Dispatched ${title}: https://github.com/acme/runner/actions/runs/1001`,
    ]);
  });

  it("sends an empty reason for a stage without one", async () => {
    const runner = fakeRunner(fakeGitHub());
    await dispatchStage(runner.scope, repo, 1, { ...deliver, reason: null });
    assert.equal(runner.dispatched[0].reason, "");
  });

  for (const status of notStartedStatuses) {
    it(`skips while a ${status} run has the same title`, async () => {
      const runner = fakeRunner(fakeGitHub());
      runner.runs.push({ id: 7, status, display_title: title });
      assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), false);
      assert.deepEqual(runner.dispatched, []);
      assert.deepEqual(runner.logs, [
        online5,
        `Not dispatching ${title}: run 7 is waiting to start`,
      ]);
    });
  }

  it("dispatches past a running run, its own run and other titles", async () => {
    const runner = fakeRunner(fakeGitHub(), 900);
    runner.runs.push(
      { id: 7, status: "in_progress", display_title: title },
      { id: 900, status: "queued", display_title: title },
      { id: 8, status: "queued", display_title: "Nibfin · acme/app#1 · review" },
      { id: 9, status: "queued", display_title: "Nibfin · acme/app#2 · deliver" },
    );
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    assert.equal(runner.dispatched.length, 1);
  });

  it("logs no URL when GitHub returns none", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    github.routes.set(`POST ${dispatchPath}`, { status: 204 });
    await dispatchStage(runner.scope, repo, 1, deliver);
    assert.deepEqual(runner.logs, [online5, `Dispatched ${title}`]);
  });

  for (const [name, answer, code] of [
    ["a 5xx", failure(502), "GITHUB_WRITE_UNCONFIRMED"],
    ["no response", networkError(), "GITHUB_WRITE_UNCONFIRMED"],
    ["a 422", failure(422, "Unexpected inputs"), "GITHUB_WRITE_REJECTED"],
  ] as const) {
    it(`fails the dispatch on ${name}`, async () => {
      const github = fakeGitHub();
      const runner = fakeRunner(github);
      github.routes.set(`POST ${dispatchPath}`, answer);
      const error = await rejection(dispatchStage(runner.scope, repo, 1, deliver));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, code);
      // Re-sent without a pre-read up to three times: a repeated wake is harmless.
      assert.equal(github.writes().length, 4);
    });
  }

  it("dispatches on a retry after any error", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    let sent = 0;
    github.routes.set(`POST ${dispatchPath}`, () =>
      ++sent < 3 ? failure(422, "Unexpected inputs") : { status: 204 },
    );
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    assert.equal(sent, 3);
    assert.deepEqual(github.waits, [1, 4]);
  });

  it("dispatches whatever case, state or busyness the matching runner has", async () => {
    for (const runners of [
      [selfHostedRunner(1, ["NIBFIN-5"])],
      [selfHostedRunner(1, ["nibfin-5"], { status: "offline" })],
      [selfHostedRunner(1, ["nibfin-5"], { busy: true })],
      [selfHostedRunner(1, ["linux"]), selfHostedRunner(2, ["gpu", "Nibfin-5"])],
    ]) {
      const runner = fakeRunner(fakeGitHub());
      runner.runners = runners;
      assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
      assert.deepEqual(runner.dispatched, [
        {
          stage: "deliver",
          repo: "acme/app",
          issue: "1",
          reason: "ci-failure",
          assignee: "5",
        },
      ]);
    }
  });

  it("finds the matching runner on a later page", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    const others = Array.from({ length: 100 }, (_, id) => selfHostedRunner(id, []));
    runner.runners = [...others, selfHostedRunner(100, ["nibfin-5"])];
    assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), true);
    const listed = github.calls.filter((call) => call.path.endsWith("/runners"));
    assert.equal(listed.length, 2);
    assert.equal(listed[0].query.get("per_page"), "100");
  });

  for (const [name, runners] of [
    ["no runner", []],
    ["only other Assignees' labels", [selfHostedRunner(1, ["nibfin-50", "nibfin-4"])]],
    ["only the old provider label", [selfHostedRunner(1, ["nibfin-5-claude"])]],
  ] as const) {
    it(`dispatches and writes nothing with ${name}`, async () => {
      const github = fakeGitHub();
      const runner = fakeRunner(github);
      runner.runners = [...runners];
      assert.equal(await dispatchStage(runner.scope, repo, 1, deliver), false);
      assert.deepEqual(runner.dispatched, []);
      assert.deepEqual(github.writes(), []);
      assert.ok(!github.calls.some((call) => call.path.endsWith("/actions/runs")));
      assert.deepEqual(runner.logs, [
        "acme/app#1: no runner of the execution repository has the label " +
          "nibfin-<id> of any Assignee (5); an ordinary assignment, nothing dispatched",
      ]);
    });
  }

  it("fails as a read when the runners cannot be listed", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    github.routes.set("GET /repos/acme/runner/actions/runners", failure(403));
    const error = await rejection(dispatchStage(runner.scope, repo, 1, deliver));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.match(error.message, /list runners of acme\/runner/);
    assert.deepEqual(runner.dispatched, []);
  });

  it("fails as a read when the runs cannot be listed", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    github.routes.set("GET /repos/acme/runner/actions/runs", failure(500));
    const error = await rejection(dispatchStage(runner.scope, repo, 1, deliver));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.deepEqual(runner.dispatched, []);
  });
});

describe("dispatchStage asks for consent (#721)", () => {
  const ann = { id: 7, login: "ann" };
  const forAnn = { ...deliver, assignees: [ann] };

  function annWorld() {
    const issues = fakeIssues(
      fakeIssue({ assignees: [ann], labels: ["scope", "shaped"] }),
    );
    const runner = fakeRunner(issues.github);
    runner.runners = [selfHostedRunner(1, ["nibfin-7"])];
    return { issues, runner };
  }

  it("pauses and dispatches nothing for a collaborator not yet asked", async () => {
    const { issues, runner } = annWorld();
    assert.equal(await dispatchStage(runner.scope, repo, 1, forAnn), false);
    assert.deepEqual(runner.dispatched, []);
    assert.ok(issues.main.labels.includes("pause"));
    assert.equal(issues.marked("consent-7").length, 1);
    assert.deepEqual(runner.logs, [
      "acme/app#1: Assignee 7 has an online runner",
      "acme/app#1: added pause for the consent of Assignee(s) 7; nothing dispatched",
    ]);
  });

  it("dispatches once the collaborator was asked", async () => {
    const { issues, runner } = annWorld();
    await dispatchStage(runner.scope, repo, 1, forAnn);
    issues.main.labels.splice(issues.main.labels.indexOf("pause"), 1);
    freshReads(issues.github.client);
    assert.equal(await dispatchStage(runner.scope, repo, 1, forAnn), true);
    assert.equal(runner.dispatched[0].assignee, "7");
    assert.equal(issues.marked("consent-7").length, 1);
  });

  it("reads no owner and pauses nothing without a runner", async () => {
    const { issues, runner } = annWorld();
    runner.runners = [];
    assert.equal(await dispatchStage(runner.scope, repo, 1, forAnn), false);
    assert.deepEqual(issues.github.writes(), []);
    assert.ok(!issues.github.calls.some((call) => call.path === "/repos/acme/runner"));
  });

  it("skips for a waiting run without pausing", async () => {
    const { issues, runner } = annWorld();
    runner.runs.push({ id: 3, status: "queued", display_title: title });
    assert.equal(await dispatchStage(runner.scope, repo, 1, forAnn), false);
    assert.deepEqual(issues.github.writes(), []);
    assert.ok(!issues.github.calls.some((call) => call.path === "/repos/acme/runner"));
  });
});

describe("chooseAssignee (#739)", () => {
  const runner = (online: boolean, ...labels: string[]) => ({
    online,
    labels: new Set(labels),
  });

  it("prefers an online runner over an earlier Assignee's offline ones", () => {
    const runners = [runner(false, "nibfin-5"), runner(true, "nibfin-7")];
    assert.deepEqual(chooseAssignee([5, 7], runners), { assignee: 7, online: true });
  });

  it("takes the first Assignee with any runner when all are offline", () => {
    const runners = [runner(false, "nibfin-7"), runner(false, "nibfin-9")];
    assert.deepEqual(chooseAssignee([5, 9, 7], runners), {
      assignee: 9,
      online: false,
    });
  });

  it("counts an Assignee as online when any of its runners is", () => {
    const runners = [
      runner(false, "nibfin-5"),
      runner(true, "linux", "nibfin-5"),
      runner(true, "nibfin-7"),
    ];
    assert.deepEqual(chooseAssignee([5, 7], runners), { assignee: 5, online: true });
  });

  it("breaks ties by Assignee order", () => {
    const runners = [runner(true, "nibfin-7"), runner(true, "nibfin-5")];
    assert.deepEqual(chooseAssignee([5, 7], runners), { assignee: 5, online: true });
    assert.deepEqual(chooseAssignee([7, 5], runners), { assignee: 7, online: true });
  });

  it("chooses nobody without a matching label", () => {
    assert.equal(chooseAssignee([5, 7], []), undefined);
    assert.equal(chooseAssignee([], [runner(true, "nibfin-5")]), undefined);
    const near = [runner(true, "nibfin-5-claude", "nibfin-50", "nibfin-7x")];
    assert.equal(chooseAssignee([5, 7], near), undefined);
  });
});

describe("dispatchStage with several Assignees (#739)", () => {
  const ann = { id: 7, login: "ann" };
  const bob = { id: 9, login: "bob" };

  /**
   * acme/app#1 with `assignees` on a fake GitHub whose execution repository is
   * owned by taco (5); `asked` already have Nibfin's consent comment.
   */
  function severalWorld(assignees: Actor[], asked: Actor[] = assignees) {
    const issues = fakeIssues(fakeIssue({ assignees, labels: ["scope", "shaped"] }));
    for (const assignee of asked) {
      seedComment(issues, issues.main, `<!-- nibfin:consent-${assignee.id} -->\n\nAsked`);
    }
    const runner = fakeRunner(issues.github);
    return { issues, runner, route: { ...deliver, assignees } };
  }

  it("dispatches to the chosen Assignee with the other inputs unchanged", async () => {
    const { runner, route } = severalWorld([taco, bob]);
    runner.runners = [
      selfHostedRunner(1, ["nibfin-5"], { status: "offline" }),
      selfHostedRunner(2, ["nibfin-9"], { busy: true }),
    ];
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), true);
    assert.deepEqual(runner.dispatched, [
      {
        stage: "deliver",
        repo: "acme/app",
        issue: "1",
        reason: "ci-failure",
        assignee: "9",
      },
    ]);
    assert.deepEqual(runner.logs, [
      "acme/app#1: Assignee 9 has an online runner",
      `Dispatched ${title}: https://github.com/acme/runner/actions/runs/1001`,
    ]);
  });

  it("queues on the first Assignee with a runner when all are offline", async () => {
    const { runner, route } = severalWorld([ann, bob, taco]);
    runner.runners = [
      selfHostedRunner(1, ["nibfin-5"], { status: "offline" }),
      selfHostedRunner(2, ["nibfin-9"], { status: "offline" }),
    ];
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), true);
    assert.equal(runner.dispatched[0].assignee, "9");
    assert.equal(
      runner.logs[0],
      "acme/app#1: Assignee 9 has only offline runners; " +
        "the Job queues until one is online",
    );
  });

  for (const [status, online] of [
    ["ONLINE", true],
    ["Offline", false],
    ["idle", false],
  ] as const) {
    const as = online ? "online" : "offline";
    it(`reads a runner status of ${status} as ${as}`, async () => {
      const { runner, route } = severalWorld([taco, bob]);
      runner.runners = [
        selfHostedRunner(1, ["nibfin-5"], { status: "offline" }),
        selfHostedRunner(2, ["NIBFIN-9"], { status }),
      ];
      assert.equal(await dispatchStage(runner.scope, repo, 1, route), true);
      assert.equal(runner.dispatched[0].assignee, online ? "9" : "5");
    });
  }

  it("dispatches, reads and writes nothing when no Assignee has a runner", async () => {
    const { issues, runner, route } = severalWorld([ann, bob], []);
    runner.runners = [selfHostedRunner(1, ["nibfin-5", "nibfin-90", "nibfin-7-codex"])];
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), false);
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(issues.github.writes(), []);
    const read = (path: string) => issues.github.calls.some((call) => call.path === path);
    assert.ok(!read("/repos/acme/runner/actions/runs"));
    assert.ok(!read("/repos/acme/runner"));
    assert.deepEqual(runner.logs, [
      "acme/app#1: no runner of the execution repository has the label " +
        "nibfin-<id> of any Assignee (7, 9); an ordinary assignment, nothing dispatched",
    ]);
  });

  it("chooses from runners on a later page", async () => {
    const { issues, runner, route } = severalWorld([taco, bob]);
    const others = Array.from({ length: 100 }, (_, id) =>
      selfHostedRunner(id, ["nibfin-5"], { status: "offline" }),
    );
    runner.runners = [...others, selfHostedRunner(100, ["nibfin-9"])];
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), true);
    assert.equal(runner.dispatched[0].assignee, "9");
    const listed = issues.github.calls.filter((call) => call.path.endsWith("/runners"));
    assert.equal(listed.length, 2);
  });

  it("skips for a waiting run even if another Assignee would be chosen", async () => {
    const { issues, runner, route } = severalWorld([taco, bob]);
    runner.runners = [selfHostedRunner(1, ["nibfin-9"])];
    runner.runs.push({ id: 3, status: "queued", display_title: title });
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), false);
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(issues.github.writes(), []);
    assert.deepEqual(runner.logs, [
      "acme/app#1: Assignee 9 has an online runner",
      `Not dispatching ${title}: run 3 is waiting to start`,
    ]);
  });

  it("asks every non-owner Assignee for consent, not only the chosen one", async () => {
    const { issues, runner, route } = severalWorld([ann, taco, bob], []);
    runner.runners = [selfHostedRunner(1, ["nibfin-5"])];
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), false);
    assert.equal(runner.dispatched.length, 0);
    assert.ok(issues.main.labels.includes("pause"));
    assert.equal(issues.marked("consent-7").length, 1);
    assert.equal(issues.marked("consent-9").length, 1);
    assert.equal(issues.marked("consent-5").length, 0);
    issues.main.labels.splice(issues.main.labels.indexOf("pause"), 1);
    freshReads(issues.github.client);
    assert.equal(await dispatchStage(runner.scope, repo, 1, route), true);
    assert.deepEqual(
      runner.dispatched.map((inputs) => inputs.assignee),
      ["5"],
    );
  });
});

describe("planDispatch (#778)", () => {
  const ann = { id: 7, login: "ann" };
  const repair = { stage: "repair" as const, reason: null, assignees: [ann] };

  function annWorld() {
    const issues = fakeIssues(fakeIssue({ assignees: [ann] }));
    const runner = fakeRunner(issues.github);
    runner.runners = [selfHostedRunner(1, ["nibfin-7"])];
    return { issues, runner };
  }

  it("plans none without a runner, writing nothing", async () => {
    const { issues, runner } = annWorld();
    runner.runners = [];
    assert.deepEqual(await planDispatch(runner.scope, repo, 1, repair), { kind: "none" });
    assert.deepEqual(issues.github.writes(), []);
  });

  it("plans waiting for a run with the title that has not started", async () => {
    const { issues, runner } = annWorld();
    const title = "Nibfin · acme/app#1 · repair";
    runner.runs.push({ id: 3, status: "queued", display_title: title });
    assert.deepEqual(await planDispatch(runner.scope, repo, 1, repair), {
      kind: "waiting",
      runId: 3,
    });
    assert.deepEqual(issues.github.writes(), []);
  });

  it("plans consent after writing pause and the consent comment", async () => {
    const { issues, runner } = annWorld();
    assert.deepEqual(await planDispatch(runner.scope, repo, 1, repair), {
      kind: "consent",
    });
    assert.ok(issues.main.labels.includes("pause"));
    assert.equal(issues.marked("consent-7").length, 1);
    assert.deepEqual(runner.dispatched, []);
  });

  it("plans ready once the Assignee was asked, without dispatching", async () => {
    const { issues, runner } = annWorld();
    seedComment(issues, issues.main, "<!-- nibfin:consent-7 -->\nAsked.");
    assert.deepEqual(await planDispatch(runner.scope, repo, 1, repair), {
      kind: "ready",
      assignee: 7,
    });
    assert.deepEqual(runner.dispatched, []);
    assert.deepEqual(issues.github.writes(), []);
  });

  it("gives the repair stage a dispatcher and a waiting-run lookup", async () => {
    const { issues, runner } = annWorld();
    seedComment(issues, issues.main, "<!-- nibfin:consent-7 -->\nAsked.");
    const dispatcher = repairDispatcher(runner.scope, repo, 1, [ann]);
    assert.equal(await dispatcher.waitingRun(), undefined);
    assert.deepEqual(await dispatcher.plan(), { kind: "ready", assignee: 7 });
    await dispatcher.dispatch(7);
    assert.deepEqual(runner.dispatched, [
      { stage: "repair", repo: "acme/app", issue: "1", reason: "", assignee: "7" },
    ]);
    const title = "Nibfin · acme/app#1 · repair";
    runner.runs.push(
      { id: 900, status: "queued", display_title: title },
      { id: 4, status: "in_progress", display_title: title },
      { id: 5, status: "waiting", display_title: title },
    );
    freshReads(issues.github.client);
    assert.equal(await dispatcher.waitingRun(), 5);
  });
});

describe("dispatchRoute", () => {
  it("dispatches a route run without looking for duplicates", async () => {
    const github = fakeGitHub();
    const runner = fakeRunner(github);
    const route = "Nibfin · acme/app#1 · route";
    runner.runs.push({ id: 7, status: "queued", display_title: route });
    await dispatchRoute(runner.scope, repo, 1);
    assert.deepEqual(runner.dispatched, [
      { stage: "route", repo: "acme/app", issue: "1" },
    ]);
    assert.ok(!github.calls.some((call) => call.path.endsWith("/actions/runs")));
  });
});
