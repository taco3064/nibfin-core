import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { defaultDeliverDeps, mergeableDelayMs, mergeableReads } from "./deliver.ts";
import { branch, type DeliveryWorld, deliveryWorld } from "./fake-delivery.test.ts";
import { commitFile, git } from "./fake-git.test.ts";
import { agentResult, type AgentStep } from "./fake-job.test.ts";

const done = agentResult({ outcome: "done" });
const pass = agentResult({ outcome: "pass" });

function next(world: DeliveryWorld): unknown {
  return JSON.parse(readFileSync(world.nextFile, "utf8"));
}

function writeFile(file: string): AgentStep {
  return (options) => {
    commitFile(options.workspace, file, `${file}\n`, `feat: add ${file}`);
    return done;
  };
}

describe("runDeliverStage when the base moves", () => {
  it("sends the moved base to the Writer and publishes the rebased head", async () => {
    const moved: { sha?: string } = {};
    const passAfterBaseMoves: AgentStep = () => {
      const { other } = world.fixture;
      moved.sha = commitFile(other, "base.txt", "base\n", "feat: base work");
      git(other, "push", "--quiet", "origin", "main");
      world.commitPulls.set(moved.sha, [
        {
          number: 330,
          title: "Base work",
          html_url: "https://github.com/acme/app/pull/330",
        },
      ]);
      return pass;
    };
    const rebase: AgentStep = (options) => {
      git(options.workspace, "rebase", "--quiet", "refs/remotes/origin/main");
      return done;
    };
    const world = await deliveryWorld({
      steps: [writeFile("a.txt"), passAfterBaseMoves, rebase, pass],
    });
    assert.equal(await world.run(), 0);
    const [, , fix, acceptor] = world.agent.runs;
    const short = git(world.fixture.workspace, "rev-parse", "--short", moved.sha!);
    assert.match(fix.prompt, /Fix every defect below/);
    assert.ok(
      fix.prompt.includes(
        `- The base branch \`main\` moved to ${moved.sha} while this delivery ran. ` +
          "Rebase the branch onto `refs/remotes/origin/main` (already fetched; you " +
          "cannot fetch it yourself)",
      ),
    );
    assert.ok(
      fix.prompt.includes(
        `- ${short} feat: base work (#330 Base work ` +
          "(https://github.com/acme/app/pull/330))",
      ),
    );
    assert.match(acceptor.prompt, /Your role is Accept sub agent\./);
    assert.equal(world.agent.runs.length, 4);
    assert.ok(
      world.agent.logs.includes(`origin/main moved to ${moved.sha}; not publishing`),
    );
    const head = world.fixture.remoteHead(branch)!;
    git(world.fixture.remote, "merge-base", "--is-ancestor", moved.sha!, head);
    assert.equal(world.pulls.length, 1);
    assert.equal(world.pulls[0].sha, head);
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
  });
});

describe("runDeliverStage after opening the pull request", () => {
  /** A world whose new PR starts with `mergeable: null`; each wait applies `later`. */
  async function computingWorld(later: (world: DeliveryWorld) => void) {
    const world = await deliveryWorld({ steps: [writeFile("a.txt"), pass] });
    const { routes } = world.issues.github;
    const create = routes.get("POST /repos/acme/app/pulls")!;
    routes.set("POST /repos/acme/app/pulls", async (request) => {
      const answer = await (typeof create === "function" ? create(request) : create);
      world.pulls[0].mergeable = null;
      return answer;
    });
    const waits = world.waits;
    world.deps.wait = (ms) => {
      waits.push(ms);
      later(world);
      return Promise.resolve();
    };
    return world;
  }

  it("asks for a conflict fix once GitHub finds the PR conflicting", async () => {
    const world = await computingWorld((w) => void (w.pulls[0].mergeable = false));
    assert.equal(await world.run(), 0);
    assert.deepEqual(world.waits, [mergeableDelayMs]);
    assert.deepEqual(next(world), {
      stage: "deliver",
      reason: "conflict",
      progressed: true,
    });
    assert.match(
      world.agent.logs.at(-1)!,
      /pull\/100 conflicts with main; asking for a conflict fix$/,
    );
  });

  it("waits between reads with a timer by default", async () => {
    assert.equal(await defaultDeliverDeps.wait(0), undefined);
  });

  it("keeps the CI rules while GitHub has not computed mergeability", async () => {
    const world = await computingWorld(() => undefined);
    assert.equal(await world.run(), 0);
    assert.equal(world.waits.length, mergeableReads - 1);
    assert.ok(
      world.agent.logs.includes(
        "GitHub has not computed the mergeability of " +
          "https://github.com/acme/app/pull/100 yet",
      ),
    );
    assert.deepEqual(next(world), { stage: "review", reason: null, progressed: true });
  });
});
