import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { failure, fakeToken } from "../github/fake-github.test.ts";
import { type ActingClient, GitHubError } from "../github/index.ts";
import { fakeRunner } from "../route/fake-runner.test.ts";
import {
  fakeIssue,
  type FakeIssues,
  fakeIssues,
  jobContext,
} from "../stages/fake-job.test.ts";
import { type FinishContext, type JobContext, StageError } from "../stages/index.ts";
import { capture } from "./fake-io.test.ts";
import { defaultRunDeps, type RunDeps, usage } from "./run.ts";
import { readVersion } from "./version.ts";

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
  const env: NodeJS.ProcessEnv = {
    NIBFIN_GITHUB_TOKEN: fakeToken,
    NIBFIN_AGENT_HOME: "/login/claude",
    NIBFIN_WORKSPACE: "/nibfin-test-workspace",
    NIBFIN_TOOL_CACHE: "/cache",
    NIBFIN_RUN_REPO: "acme/runner",
    NIBFIN_RUN_ID: "900",
  };
  const args = ["--repo", "acme/app", "--issue", "1", "--provider", "claude"];

  function stageDeps(
    outcome: (context: JobContext) => Promise<number>,
    issues: FakeIssues = fakeIssues(fakeIssue({ labels: ["scope", "pause"] })),
  ) {
    const seen: { token?: string; context?: JobContext | FinishContext } = {};
    const client = issues.github.client;
    const runner = fakeRunner(issues.github);
    const stage = (context: JobContext, given: ActingClient) => {
      assert.equal(given, client);
      seen.context = context;
      return outcome(context);
    };
    const finish = (context: FinishContext, given: ActingClient) => {
      assert.equal(given, client);
      seen.context = context;
      return Promise.resolve(0);
    };
    const deps: RunDeps = {
      env,
      connect: (token) => {
        seen.token = token;
        return Promise.resolve(client);
      },
      stages: { shape: stage, deliver: stage, review: stage, finish },
    };
    return { deps, seen, issues, runner };
  }

  it("runs the Shape stage with the Job context", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.deepEqual(result, {
      code: 0,
      stdout: "NIBFIN_NEXT_FILE is not set; nothing is dispatched\n",
      stderr: "",
    });
    assert.equal(t.seen.token, fakeToken);
    assert.deepEqual(t.seen.context?.repo, { owner: "acme", repo: "app" });
    assert.equal(t.seen.context?.issue, 1);
  });

  it("runs the Deliver stage with its reason", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const deliver = ["run", "--stage", "deliver", ...args, "--reason", "cd-failure"];
    assert.equal((await capture(deliver, t.deps)).code, 0);
    assert.equal((t.seen.context as JobContext | undefined)?.reason, "cd-failure");
  });

  it("runs the review stage", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const review = ["run", "--stage", "review", ...args];
    assert.equal((await capture(review, t.deps)).code, 0);
    assert.equal(t.seen.context?.issue, 1);
    const withReason = await capture([...review, "--reason", "review"], t.deps);
    assert.equal(withReason.code, 1);
    assert.match(withReason.stderr, /--reason is only valid with --stage deliver/);
  });

  it("runs the finish stage without the agent fields", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const finish = ["run", "--stage", "finish", "--repo", "acme/app", "--issue", "1"];
    t.deps.env = { NIBFIN_GITHUB_TOKEN: fakeToken, NIBFIN_RUN_REPO: "acme/runner" };
    assert.equal((await capture(finish, t.deps)).code, 0);
    assert.deepEqual(t.seen.context, {
      repo: { owner: "acme", repo: "app" },
      issue: 1,
      token: fakeToken,
      runRepo: { owner: "acme", repo: "runner" },
    });
    const withProvider = await capture([...finish, "--provider", "claude"], t.deps);
    assert.equal(withProvider.code, 1);
    assert.match(withProvider.stderr, /--provider is not valid with --stage finish/);
  });

  it("uses the Shape, Deliver, review and finish stages by default", async () => {
    assert.deepEqual(Object.keys(defaultRunDeps.stages), [
      "shape",
      "deliver",
      "review",
      "finish",
    ]);
    const issues = fakeIssues(fakeIssue({ state: "closed" }));
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    // Only text lines are the stages' output; the test runner's own reports pass.
    process.stdout.write = (text: string | Uint8Array, ...rest: never[]) => {
      if (typeof text !== "string") {
        return write(text, ...rest);
      }
      lines.push(text);
      return true;
    };
    try {
      const context = jobContext("/nibfin-test-workspace");
      const { client } = issues.github;
      assert.equal(await defaultRunDeps.stages.deliver(context, client), 0);
      assert.equal(await defaultRunDeps.stages.review(context, client), 0);
      const { repo, issue, token } = context;
      assert.equal(await defaultRunDeps.stages.finish({ repo, issue, token }, client), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(lines, [
      "acme/app#1 is not at the deliver stage: ineligible (closed) (no reason)\n",
      "acme/app#1 is not at the review stage: ineligible (closed)\n",
      "acme/app#1 is not at the review stage: ineligible (closed)\n",
    ]);
  });

  it("connects with the token's own account, logging rate limits", async () => {
    const original = globalThis.fetch;
    const answers = [
      // A primary rate limit whose reset has passed: retried at once.
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
        },
      ),
      Response.json({ id: 7, login: "owner" }),
    ];
    globalThis.fetch = () => Promise.resolve(answers.shift()!);
    const lines: string[] = [];
    try {
      const client = await defaultRunDeps.connect("token", (line) => lines.push(line));
      assert.deepEqual(client.actor, { id: 7, login: "owner" });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(lines, [
      "GitHub GET /user (retry 1 of 3): primary rate limit; waiting 0 s",
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
    t.deps.env = { ...env, NIBFIN_RUN_ID: "x" };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "nibfin: STAGE_INPUT_INVALID: NIBFIN_RUN_ID must be a positive integer\n",
    );
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("fails without pending when the token's account cannot be read", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    t.deps.connect = () =>
      Promise.reject(new GitHubError("GITHUB_READ_FAILED", "read user", new Error()));
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_READ_FAILED: read user/);
    assert.deepEqual(t.issues.github.writes(), []);
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
    it(`prints ${name} without the token, adds pending and fails`, async () => {
      // A stage may fail with any value; the CLI must still print it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const t = stageDeps(() => Promise.reject(error));
      const result = await capture(["run", "--stage", "shape", ...args], t.deps);
      assert.deepEqual(result, {
        code: 1,
        stdout: "Added pending to acme/app#1\n",
        stderr: expected,
      });
      assert.ok(!result.stderr.includes(fakeToken));
      assert.ok(t.issues.main.labels.includes("pending"));
      const [comment] = t.issues.marked("pending");
      assert.ok(!comment.body.includes(fakeToken));
      assert.match(comment.body, /acme\/runner\/actions\/runs\/900/);
    });
  }

  it("adds no pending while another Writer runs", async () => {
    const error = new StageError("STAGE_WRITER_ACTIVE", "another Writer runs");
    const t = stageDeps(() => Promise.reject(error));
    const result = await capture(["run", "--stage", "deliver", ...args], t.deps);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "nibfin: STAGE_WRITER_ACTIVE: another Writer runs\n");
    assert.deepEqual(t.issues.github.writes(), []);
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("reports a pending write that fails too", async () => {
    const t = stageDeps(() => Promise.reject(new Error("boom")));
    t.issues.github.routes.set("GET /repos/acme/app/issues/1/comments", failure(500));
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: boom\nnibfin: could not add pending: /);
  });

  it("returns a non-zero stage exit code without dispatching", async () => {
    const t = stageDeps(() => Promise.resolve(3));
    assert.equal((await capture(["run", "--stage", "shape", ...args], t.deps)).code, 3);
    assert.deepEqual(t.runner.dispatched, []);
  });

  async function withNextFile(next: unknown) {
    const dir = await makeTempDir("cli-next-");
    const nextFile = join(dir, "next.json");
    writeFileSync(nextFile, JSON.stringify(next));
    return nextFile;
  }

  function atShape() {
    return stageDeps(
      () => Promise.resolve(0),
      fakeIssues(fakeIssue({ labels: ["scope"] })),
    );
  }

  it("continues the Issue after a stage from the next-action file", async () => {
    const t = atShape();
    const nextFile = await withNextFile({
      stage: null,
      reason: null,
      wake: [{ repo: "acme/lib", issue: 2 }],
      progressed: true,
    });
    t.deps.env = { ...env, NIBFIN_NEXT_FILE: nextFile };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 0);
    assert.deepEqual(
      t.runner.dispatched.map((inputs) => inputs.stage),
      ["route", "shape"],
    );
    assert.match(result.stdout, /Dispatched Nibfin · acme\/lib#2 · route/);
    assert.match(result.stdout, /Dispatched Nibfin · acme\/app#1 · shape/);
  });

  it("adds pending when the stage made no progress", async () => {
    const t = atShape();
    const nextFile = await withNextFile({ stage: null, reason: null, progressed: false });
    t.deps.env = { ...env, NIBFIN_NEXT_FILE: nextFile };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: STAGE_NO_PROGRESS: /);
    assert.ok(t.issues.main.labels.includes("pending"));
    assert.deepEqual(t.runner.dispatched, []);
  });

  it("adds pending when a dispatch fails", async () => {
    const t = atShape();
    const path =
      "/repos/acme/runner/actions/workflows/nibfin-shared-runner.yml/dispatches";
    t.issues.github.routes.set(`POST ${path}`, failure(422));
    const nextFile = await withNextFile({ stage: null, reason: null, progressed: true });
    t.deps.env = { ...env, NIBFIN_NEXT_FILE: nextFile };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^nibfin: GITHUB_WRITE_REJECTED: dispatch /);
    assert.ok(t.issues.main.labels.includes("pending"));
  });

  it("needs the execution repository to continue the Issue", async () => {
    const t = stageDeps(() => Promise.resolve(0));
    const nextFile = await withNextFile({ stage: null, reason: null, progressed: true });
    t.deps.env = { ...env, NIBFIN_RUN_REPO: undefined, NIBFIN_NEXT_FILE: nextFile };
    const result = await capture(["run", "--stage", "shape", ...args], t.deps);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /STAGE_INPUT_INVALID: NIBFIN_RUN_REPO is missing/);
  });
});
