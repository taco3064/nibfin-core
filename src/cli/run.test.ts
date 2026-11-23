import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeActor, fakeToken } from "../github/fake-github.test.ts";
import { type ActingClient, GitHubError } from "../github/index.ts";
import { fakeIssue, fakeIssues, jobContext } from "../stages/fake-job.test.ts";
import { type JobContext, StageError } from "../stages/index.ts";
import { defaultRunDeps, run, type RunDeps, usage } from "./run.ts";
import { readVersion } from "./version.ts";

async function capture(args: readonly string[], deps?: RunDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
    deps,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("run", () => {
  it("prints the version for --version", async () => {
    assert.deepEqual(await capture(["--version"]), {
      code: 0,
      stdout: `${readVersion()}\n`,
      stderr: "",
    });
  });

  it("prints usage to stdout for --help", async () => {
    assert.deepEqual(await capture(["--help"]), { code: 0, stdout: usage, stderr: "" });
  });

  for (const args of [[], ["--unknown"], ["run"], ["--version", "--help"]]) {
    it(`prints usage to stderr and fails for ${JSON.stringify(args)}`, async () => {
      assert.deepEqual(await capture(args), { code: 1, stdout: "", stderr: usage });
    });
  }
});

describe("run --stage", () => {
  const env = {
    NIBFIN_GITHUB_TOKEN: fakeToken,
    NIBFIN_ACTOR_ID: String(fakeActor.id),
    NIBFIN_ACTOR_LOGIN: fakeActor.login,
    NIBFIN_AGENT_HOME: "/login/claude",
    NIBFIN_WORKSPACE: "/workspace",
    NIBFIN_TOOL_CACHE: "/cache",
  };
  const args = ["--repo", "acme/app", "--issue", "1", "--provider", "claude"];

  function stageDeps(outcome: (context: JobContext) => Promise<number>) {
    const seen: { token?: string; context?: JobContext } = {};
    const client = { actor: fakeActor } as unknown as ActingClient;
    const deps: RunDeps = {
      env,
      createClient: (token) => {
        seen.token = token;
        return client;
      },
      stages: {
        shape: (context, given) => {
          assert.equal(given, client);
          seen.context = context;
          return outcome(context);
        },
        deliver: (context) => {
          seen.context = context;
          return outcome(context);
        },
        review: (context) => {
          seen.context = context;
          return outcome(context);
        },
      },
    };
    return { deps, seen };
  }

  it("runs the Shape stage with the Job context", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(t.seen.token, fakeToken);
    assert.deepEqual(t.seen.context?.repo, { owner: "acme", repo: "app" });
    assert.equal(t.seen.context?.issue, 1);
  });

  it("runs the Deliver stage with its reason", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const deliver = ["run", "--stage", "deliver", ...args, "--reason", "cd-failure"];
    const result = await capture(deliver, t.deps);
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(t.seen.context?.reason, "cd-failure");
  });

  it("runs the review stage", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const review = ["run", "--stage", "review", ...args];
    const result = await capture(review, t.deps);
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(t.seen.context?.issue, 1);
    const withReason = await capture([...review, "--reason", "review"], t.deps);
    assert.equal(withReason.code, 1);
    assert.match(withReason.stderr, /--reason is only valid with --stage deliver/);
  });

  it("uses the Shape, Deliver and review stages by default", async () => {
    assert.deepEqual(Object.keys(defaultRunDeps.stages), ["shape", "deliver", "review"]);
    const issues = fakeIssues(fakeIssue({ state: "closed" }));
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (text: string) => {
      lines.push(text);
      return true;
    };
    try {
      const context = jobContext("/workspace");
      const { client } = issues.github;
      assert.equal(await defaultRunDeps.stages.deliver(context, client), 0);
      assert.equal(await defaultRunDeps.stages.review(context, client), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(lines, [
      "acme/app#1 is not at the deliver stage: ineligible (closed) (no reason)\n",
      "acme/app#1 is not at the review stage: ineligible (closed)\n",
    ]);
  });

  for (const stage of [[], ["--stage"], ["--stage", "accept"], ["--stage", "toString"]]) {
    it(`prints usage for ${JSON.stringify(stage)}`, async () => {
      const t = stageDeps(() => Promise.resolve(0));
      const result = await capture(["run", ...stage, ...args], t.deps);
      assert.deepEqual(result, { code: 1, stdout: "", stderr: usage });
      assert.deepEqual(t.seen, {});
    });
  }

  it("names an invalid context field without its value", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    t.deps.env = { ...env, NIBFIN_ACTOR_ID: "x" };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "nibfin: STAGE_INPUT_INVALID: NIBFIN_ACTOR_ID must be a positive integer\n",
    );
  });

  for (const [name, error, expected] of [
    [
      "a stage error",
      new StageError("STAGE_BLOCKED", "Shape Validator returned blocked"),
      "nibfin: STAGE_BLOCKED: Shape Validator returned blocked\n",
    ],
    [
      "a GitHub error",
      new GitHubError("GITHUB_READ_FAILED", "read acme/app#1", new Error(fakeToken)),
      "nibfin: GITHUB_READ_FAILED: read acme/app#1: read failed (no response)\n",
    ],
    ["an uncoded error", new Error("boom"), "nibfin: boom\n"],
    ["a thrown value", "odd", "nibfin: odd\n"],
  ] as const) {
    it(`prints ${name} without the token and fails`, async () => {
      // A stage may fail with any value; the CLI must still print it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const t = stageDeps(() => Promise.reject(error));
      const result = await capture(["run", "--stage", "shape", ...args], t.deps);
      assert.deepEqual(result, { code: 1, stdout: "", stderr: expected });
      assert.ok(!result.stderr.includes(fakeToken));
    });
  }

  it("returns the stage's exit code", async () => {
    const t = stageDeps(() => Promise.resolve(3));
    assert.equal((await capture(["run", "--stage", "shape", ...args], t.deps)).code, 3);
  });
});
