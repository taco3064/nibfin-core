import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failure, type FakeRequest } from "../github/fake-github.test.ts";
import { fakeWorld, type FakeWorld, type WorldIssue } from "../github/fake-world.test.ts";
import { codeOf } from "./pending.ts";
import {
  listIssues,
  type PublishOutcome,
  publishRequestPlan,
  type PublishScope,
  type Recheck,
} from "./scope-publish.ts";
import type { PlannedIssue, RequestPlan } from "./scope-roles.ts";

const requestUrl = "https://github.com/acme/app/issues/1";
const marker = "<!-- nibfin:scope-request -->";

const bodyOf = (title: string) => `${title}, in detail.\n\nOrigin: ${requestUrl}`;

function fresh(
  key: string,
  repository: string,
  title: string,
  blockedBy: string[] = [],
): PlannedIssue {
  return { key, repository, title, body: bodyOf(title), blockedBy };
}

function reuse(key: string, url: string, blockedBy: string[] = []): PlannedIssue {
  return { key, reuse: url, blockedBy };
}

function planOf(issues: PlannedIssue[]): RequestPlan {
  return { request: requestUrl, investigation: "Feasible.", report: "r", issues };
}

interface Setup {
  world: FakeWorld;
  request: WorldIssue;
  logs: string[];
  rechecks: Recheck[];
  scope: PublishScope;
  publish: (issues: PlannedIssue[]) => Promise<PublishOutcome>;
  /** The writes, as `<METHOD> <path>`. */
  writes: () => string[];
}

function setup(assignees: string[] = ["taco"]): Setup {
  const world = fakeWorld();
  const request = world.add({
    repo: "app",
    number: 1,
    title: "Please add X",
    body: "Please add X.",
    labels: ["request"],
    assignees,
  });
  // An existing Issue in each repository, unrelated to the request.
  world.add({ repo: "lib", number: 50, title: "Existing work", body: "Other." });
  world.add({ repo: "app", number: 3, title: "App work", body: "Other." });
  const logs: string[] = [];
  const rechecks: Recheck[] = [];
  const scope: PublishScope = {
    client: world.github.client,
    issue: { owner: "acme", repo: "app", number: 1 },
    assignees,
    log: (line) => logs.push(line),
    recheck: () => Promise.resolve(rechecks.shift() ?? "scope"),
  };
  return {
    world,
    request,
    logs,
    rechecks,
    scope,
    publish: (issues) => publishRequestPlan(scope, planOf(issues)),
    writes: () => world.github.writes().map((call) => `${call.method} ${call.path}`),
  };
}

/** A hook that answers `status` for every request matching `match`. */
function failWhen(
  world: FakeWorld,
  match: (request: FakeRequest) => boolean,
  status = 403,
): void {
  world.hook = (request, apply) => (match(request) ? failure(status) : apply());
}

const isPost = (path: string) => (request: FakeRequest) =>
  request.method === "POST" && request.path === path;

function person(outcome: PublishOutcome) {
  if (outcome.kind !== "person") {
    throw new Error(`Expected a person outcome: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("publishRequestPlan", () => {
  it("creates, links, assigns and labels, then comments and closes", async () => {
    const t = setup();
    const outcome = await t.publish([
      fresh("parser", "acme/lib", "Add the X parser"),
      fresh("cli", "acme/app", "Use the X parser", [
        "parser",
        "https://github.com/acme/lib/issues/50",
      ]),
    ]);
    const parser = t.world.get("acme/lib#51");
    const cli = t.world.get("acme/app#4");
    assert.deepEqual(outcome, {
      kind: "published",
      published: [
        { key: "parser", url: "https://github.com/acme/lib/issues/51" },
        { key: "cli", url: "https://github.com/acme/app/issues/4" },
      ],
    });
    assert.deepEqual(
      [parser.title, parser.body],
      ["Add the X parser", bodyOf("Add the X parser")],
    );
    assert.deepEqual(cli.blockedBy, ["acme/lib#51", "acme/lib#50"]);
    for (const issue of [parser, cli]) {
      assert.deepEqual(issue.labels, ["scope"]);
      assert.deepEqual(issue.assignees, ["taco"]);
    }
    assert.equal(t.request.state, "closed");
    assert.equal(t.request.stateReason, "completed");
    assert.deepEqual(t.request.labels, ["request"]);
    const [comment] = t.request.comments;
    assert.equal(
      comment.body,
      `${marker}\nNibfin's Scope stage published this request, so it is closed as ` +
        "completed.\n\nIssues:\n- parser: https://github.com/acme/lib/issues/51\n" +
        "- cli: https://github.com/acme/app/issues/4",
    );
    assert.deepEqual(t.writes(), [
      "POST /repos/acme/lib/issues",
      "POST /repos/acme/app/issues",
      "POST /repos/acme/app/issues/4/dependencies/blocked_by",
      "POST /repos/acme/app/issues/4/dependencies/blocked_by",
      "POST /repos/acme/lib/issues/51/assignees",
      "POST /repos/acme/lib/issues/51/labels",
      "POST /repos/acme/app/issues/4/assignees",
      "POST /repos/acme/app/issues/4/labels",
      "POST /repos/acme/app/issues/1/comments",
      "PATCH /repos/acme/app/issues/1",
    ]);
    assert.ok(t.logs.includes("parser: created https://github.com/acme/lib/issues/51"));
    assert.ok(t.logs.includes("Closed the request as completed"));
    assert.ok(!t.world.github.calls.some((call) => call.path.startsWith("/search")));
  });

  it("retries the read-back of a created Issue that GraphQL lags (#768)", async () => {
    const t = setup();
    let lagging = 1;
    t.world.github.routes.set("GRAPHQL IssueRecord", (request) => {
      const { variables } = request.body as { variables: { number: number } };
      if (variables.number !== 51 || lagging === 0) {
        return undefined as never;
      }
      lagging -= 1;
      return { data: { data: { repository: { issueOrPullRequest: null } } } };
    });
    const outcome = await t.publish([fresh("parser", "acme/lib", "Add the X parser")]);
    assert.equal(outcome.kind, "published");
    assert.equal(t.request.state, "closed");
    assert.ok(
      t.world.github.log.includes(
        "GitHub read acme/lib#51 (retry 1 of 3): incomplete answer; waiting 1 s",
      ),
    );
    assert.equal(lagging, 0);
  });

  it("reuses the request's own Issues with their bodies unchanged", async () => {
    const t = setup();
    const own = t.world.add({
      repo: "lib",
      number: 7,
      title: "Earlier",
      body: bodyOf("E"),
    });
    const done = t.world.add({
      repo: "lib",
      number: 8,
      title: "Done",
      body: bodyOf("D"),
      state: "closed",
      stateReason: "completed",
      labels: ["delivered"],
    });
    const outcome = await t.publish([
      reuse("own", t.world.url(own), [t.world.url(done)]),
      reuse("done", t.world.url(done)),
    ]);
    assert.equal(outcome.kind, "published");
    assert.equal(own.body, bodyOf("E"));
    assert.deepEqual(own.labels, ["scope"]);
    assert.deepEqual(own.blockedBy, ["acme/lib#8"]);
    assert.deepEqual(done.labels, ["delivered"]);
    assert.deepEqual(done.assignees, []);
    assert.ok(!t.writes().some((write) => write.includes("/issues/8")));
    assert.match(
      t.request.comments[0].body,
      /- done: https:\/\/github.com\/acme\/lib\/issues\/8/,
    );
  });

  it("converges on a redo without duplicate Issues, edges or comments", async () => {
    const t = setup();
    const plan = [
      fresh("parser", "acme/lib", "Add the X parser"),
      fresh("cli", "acme/app", "Use the X parser", ["parser"]),
    ];
    // The first run stops when GitHub refuses the close.
    failWhen(t.world, (request) => request.method === "PATCH");
    const first = person(await t.publish(plan));
    assert.equal(first.verdict, "PARTIAL_PUBLICATION");
    assert.equal(codeOf(first.error), "GITHUB_WRITE_REJECTED");
    t.world.hook = (_request, apply) => apply();
    const before = t.writes().length;
    // The next Plan reuses both through their cross-references.
    const second = await t.publish([
      reuse("parser", "https://github.com/acme/lib/issues/51"),
      reuse("cli", "https://github.com/acme/app/issues/4", ["parser"]),
    ]);
    assert.equal(second.kind, "published");
    assert.deepEqual(t.writes().slice(before), ["PATCH /repos/acme/app/issues/1"]);
    assert.equal(t.request.comments.length, 1);
    assert.deepEqual(t.world.get("acme/app#4").blockedBy, ["acme/lib#51"]);
  });

  it("adopts an Issue created earlier whose cross-reference lags", async () => {
    const t = setup();
    const lagging = t.world.add({
      repo: "lib",
      number: 60,
      title: "Add the X parser",
      body: bodyOf("Add the X parser"),
      crossReferenced: false,
    });
    const outcome = await t.publish([fresh("parser", "acme/lib", "Add the X parser")]);
    assert.equal(outcome.kind, "published");
    assert.ok(!t.writes().includes("POST /repos/acme/lib/issues"));
    assert.deepEqual(lagging.labels, ["scope"]);
    assert.ok(
      t.logs.includes(`parser: adopting ${t.world.url(lagging)}, created earlier`),
    );
  });

  it("ignores Issues closed as not planned or as a duplicate", async () => {
    const t = setup();
    for (const [number, stateReason] of [
      [61, "not_planned"],
      [62, "duplicate"],
    ] as const) {
      t.world.add({
        repo: "lib",
        number,
        title: "Add the X parser",
        body: bodyOf("Add the X parser"),
        state: "closed",
        stateReason,
      });
    }
    const outcome = await t.publish([fresh("parser", "acme/lib", "Add the X parser")]);
    assert.equal(outcome.kind, "published");
    assert.ok(t.writes().includes("POST /repos/acme/lib/issues"));
  });

  describe("replans before any write", () => {
    async function expectReplan(t: Setup, issues: PlannedIssue[], reason: RegExp) {
      const outcome = person(await t.publish(issues));
      assert.equal(outcome.verdict, "REPLAN_REQUIRED");
      assert.match(outcome.reason, reason);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(t.writes(), []);
      return outcome;
    }

    it("for an origin Issue the plan does not list", async () => {
      const t = setup();
      const own = t.world.add({
        repo: "lib",
        number: 7,
        title: "Earlier",
        body: bodyOf("E"),
      });
      await expectReplan(
        t,
        [fresh("parser", "acme/lib", "Add the X parser")],
        new RegExp(`The request's own Issues ${t.world.url(own)} are not in the plan`),
      );
    });

    it("for a reuse discarded since the Plan", async () => {
      const t = setup();
      const own = t.world.add({
        repo: "lib",
        number: 7,
        title: "Earlier",
        body: bodyOf("E"),
        state: "closed",
        stateReason: "not_planned",
      });
      const outcome = await expectReplan(
        t,
        [reuse("own", t.world.url(own))],
        /issues\/7 \(own\) is no longer one of its own Issues/,
      );
      assert.deepEqual(outcome.published, []);
    });

    for (const [name, fields] of [
      ["an open Issue with another body", { body: "Different." }],
      ["a closed Issue", { state: "closed", stateReason: "completed" }],
      ["an Issue of the request reused elsewhere", { body: bodyOf("Add the X parser") }],
    ] as Array<[string, Partial<WorldIssue>]>) {
      it(`for a title collision with ${name}`, async () => {
        const t = setup();
        const other = t.world.add({
          repo: "lib",
          number: 70,
          title: "Add the X parser",
          ...fields,
        });
        const issues = [fresh("parser", "acme/lib", "Add the X parser")];
        if (other.body.includes(requestUrl)) {
          issues.push(reuse("old", t.world.url(other)));
        }
        await expectReplan(t, issues, /parser: .*issues\/70 already has the title/);
      });
    }

    it("for two adoptable Issues of one title", async () => {
      const t = setup();
      for (const number of [70, 71]) {
        t.world.add({
          repo: "lib",
          number,
          title: "Add the X parser",
          body: bodyOf("Add the X parser"),
          crossReferenced: false,
        });
      }
      await expectReplan(
        t,
        [fresh("parser", "acme/lib", "Add the X parser")],
        /issues\/70, https:\/\/github.com\/acme\/lib\/issues\/71 already has the title/,
      );
    });

    it("for a new edge on a reused Issue that already has scope", async () => {
      const t = setup();
      const own = t.world.add({
        repo: "lib",
        number: 7,
        title: "Earlier",
        body: bodyOf("E"),
        labels: ["scope"],
      });
      const outcome = await expectReplan(
        t,
        [
          fresh("parser", "acme/lib", "Add the X parser"),
          reuse("own", t.world.url(own), ["parser"]),
        ],
        /issues\/7 \(own\) already has `scope`, but the plan adds Blocked by parser/,
      );
      assert.deepEqual(outcome.published, [{ key: "own", url: t.world.url(own) }]);
    });

    it("for a new edge on a closed reused Issue", async () => {
      const t = setup();
      const own = t.world.add({
        repo: "lib",
        number: 7,
        title: "Earlier",
        body: bodyOf("E"),
        state: "closed",
        stateReason: "completed",
      });
      await expectReplan(
        t,
        [reuse("own", t.world.url(own), ["https://github.com/acme/lib/issues/50"])],
        /issues\/7 \(own\) is closed, but the plan adds Blocked by/,
      );
    });

    it("but not for an adopted Issue with scope whose edges exist", async () => {
      const t = setup();
      t.world.add({
        repo: "lib",
        number: 60,
        title: "Add the X parser",
        body: bodyOf("Add the X parser"),
        labels: ["scope"],
        blockedBy: ["acme/lib#50"],
        crossReferenced: false,
      });
      const outcome = await t.publish([
        fresh("parser", "acme/lib", "Add the X parser", [
          "https://github.com/acme/lib/issues/50",
        ]),
      ]);
      assert.equal(outcome.kind, "published");
    });
  });

  describe("is blocked before any write", () => {
    it("when an Assignee cannot be assigned", async () => {
      const t = setup();
      t.world.unassignable.add("acme/lib:taco");
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PUBLICATION_BLOCKED");
      assert.equal(outcome.reason, "taco cannot be assigned in acme/lib.");
      assert.deepEqual(t.writes(), []);
    });

    it("when the request has no Assignee", async () => {
      const t = setup([]);
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PUBLICATION_BLOCKED");
      assert.match(outcome.reason, /no Assignee/);
    });

    it("when a URL blocker is outside the plan's repositories", async () => {
      const t = setup();
      t.world.add({ repo: "secret", number: 2 });
      const outcome = person(
        await t.publish([
          fresh("parser", "acme/lib", "P", ["https://github.com/acme/secret/issues/2"]),
        ]),
      );
      assert.equal(outcome.verdict, "PUBLICATION_BLOCKED");
      assert.match(outcome.reason, /parser is Blocked by .*secret\/issues\/2, outside/);
      assert.ok(!t.world.github.calls.some((call) => call.path.includes("/secret/")));
    });
  });

  describe("asks a person after a failed write", () => {
    it("lists the Issues created before a refused create", async () => {
      const t = setup();
      failWhen(t.world, isPost("/repos/acme/app/issues"));
      const outcome = person(
        await t.publish([
          fresh("parser", "acme/lib", "P"),
          fresh("cli", "acme/app", "C", ["parser"]),
        ]),
      );
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
      assert.deepEqual(outcome.published, [
        { key: "parser", url: "https://github.com/acme/lib/issues/51" },
      ]);
      assert.equal(codeOf(outcome.error), "GITHUB_WRITE_REJECTED");
      assert.match(outcome.reason, /create Issue "C" in acme\/app/);
      assert.deepEqual(t.world.get("acme/lib#51").labels, []);
    });

    it("is blocked when the first write is refused", async () => {
      const t = setup();
      failWhen(t.world, isPost("/repos/acme/lib/issues"));
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PUBLICATION_BLOCKED");
      assert.deepEqual(outcome.published, []);
    });

    it("is partial when the first write's outcome stays unknown", async () => {
      const t = setup();
      failWhen(t.world, isPost("/repos/acme/lib/issues"), 502);
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
      assert.equal(codeOf(outcome.error), "GITHUB_WRITE_UNCONFIRMED");
    });

    it("is partial when a created Issue does not read back as planned", async () => {
      const t = setup();
      t.world.hook = (request, apply) => {
        if (isPost("/repos/acme/lib/issues")(request)) {
          (request.body as { title: string }).title = "Changed";
        }
        return apply();
      };
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
      assert.equal(codeOf(outcome.error), "GITHUB_WRITE_UNCONFIRMED");
      const { cause } = outcome.error as Error;
      assert.match((cause as Error).message, /did not read back with the planned title/);
    });

    it("is partial when scope does not read back", async () => {
      const t = setup();
      t.world.hook = (request, apply) =>
        request.method === "POST" && request.path.endsWith("/labels")
          ? { data: [] }
          : apply();
      const outcome = person(await t.publish([fresh("parser", "acme/lib", "P")]));
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
      assert.match(outcome.reason, /add scope to .*lib\/issues\/51/);
      assert.equal(t.request.state, "open");
      assert.deepEqual(t.request.comments, []);
    });

    it("is partial when a refused write follows earlier ones", async () => {
      const t = setup();
      const own = t.world.add({ repo: "lib", number: 7, title: "E", body: bodyOf("E") });
      failWhen(t.world, (request) => request.path.endsWith("/labels"));
      const outcome = person(await t.publish([reuse("own", t.world.url(own))]));
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
      assert.deepEqual(own.assignees, ["taco"]);
    });

    it("keeps a non-Error failure as its text", async () => {
      const t = setup();
      const scope = {
        ...t.scope,
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        recheck: () => Promise.reject("odd"),
      };
      const outcome = person(
        await publishRequestPlan(scope, planOf([fresh("p", "acme/lib", "P")])),
      );
      assert.equal(outcome.reason, "odd");
      assert.equal(outcome.verdict, "PARTIAL_PUBLICATION");
    });
  });

  describe("stops", () => {
    it("before Assignees and scope when the request left Scope", async () => {
      const t = setup();
      t.rechecks.push("stopped");
      const outcome = await t.publish([fresh("parser", "acme/lib", "P")]);
      assert.deepEqual(outcome, { kind: "stopped" });
      assert.deepEqual(t.writes(), ["POST /repos/acme/lib/issues"]);
    });

    it("before the comment and close when the request was edited", async () => {
      const t = setup();
      t.rechecks.push("scope", "changed");
      const outcome = await t.publish([fresh("parser", "acme/lib", "P")]);
      assert.deepEqual(outcome, { kind: "changed" });
      assert.deepEqual(t.request.comments, []);
      assert.equal(t.request.state, "open");
      assert.deepEqual(t.world.get("acme/lib#51").labels, ["scope"]);
    });
  });
});

describe("listIssues", () => {
  it("lists by key or says none", () => {
    assert.equal(listIssues([]), "None.");
    assert.equal(listIssues([{ key: "a", url: "u" }]), "- a: u");
  });
});
