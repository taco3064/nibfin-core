import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { AgentError } from "../agent/index.ts";
import { rejection } from "../github/fake-github.test.ts";
import { readIssueRecord } from "../github/index.ts";
import { defaultStageDeps, prepareStageJob, runStageAgent } from "./agent.ts";
import { StageError } from "./errors.ts";
import {
  fakeDeps,
  fakeIssue,
  fakeIssues,
  jobContext,
  makeCommittedWorkspace,
  seedComment,
} from "./fake-job.test.ts";
import type { StageRole } from "./prompt.ts";
import { readWorkspaceState } from "./workspace.ts";

const reader: StageRole = {
  name: "reader",
  title: "Reader",
  skill: "accept",
  readOnly: true,
  resultFormat: "Say done.",
};
const writer: StageRole = { ...reader, name: "writer", title: "Writer", readOnly: false };
const sections = [{ title: "Task", body: "Read." }];

let workspace: string;
before(async () => {
  workspace = await makeCommittedWorkspace("stage-agent-");
});

/** A workspace that ignores `cache/` (committed) and `/AGENTS.md` (`info/exclude`). */
async function ignoringWorkspace(prefix: string): Promise<string> {
  const dir = await makeCommittedWorkspace(prefix);
  await writeFile(join(dir, ".gitignore"), "cache/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("add", ".gitignore");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    "ignore",
  );
  await mkdir(join(dir, ".git", "info"), { recursive: true });
  await writeFile(join(dir, ".git", "info", "exclude"), "/AGENTS.md\n");
  return dir;
}

async function job(steps: Parameters<typeof fakeDeps>[0], dir = workspace) {
  const issues = fakeIssues(fakeIssue());
  const fake = fakeDeps(steps, { tools: {}, skills: {} });
  const prepared = await prepareStageJob(
    jobContext(dir),
    issues.github.client,
    fake.deps,
    [reader.skill],
  );
  return { issues, fake, job: prepared };
}

describe("runStageAgent", () => {
  it("runs the role with its skill text and returns the final message", async () => {
    const t = await job(["Finished."]);
    assert.equal(await runStageAgent(t.job, reader, sections), "Finished.");
    const [run] = t.fake.runs;
    assert.equal(run?.provider, "claude");
    assert.equal("model" in run, false);
    assert.match(run.prompt, /^SKILL TEXT OF accept\n\n---\n\nYour role is Reader\./);
    assert.deepEqual(t.fake.skillReads, ["accept"]);
    assert.deepEqual(t.fake.toolPreparations, [{ tools: {}, cacheDir: "/cache" }]);
  });

  it("lets a writing role change the workspace", async () => {
    const dir = await makeCommittedWorkspace("stage-writer-");
    const t = await job(
      [
        async () => {
          await writeFile(join(dir, "change.txt"), "x");
          return "Wrote.";
        },
      ],
      dir,
    );
    assert.equal(await runStageAgent(t.job, writer, sections), "Wrote.");
  });

  it("refuses a read-only role in a workspace with changes", async () => {
    const dir = await makeCommittedWorkspace("stage-dirty-");
    await writeFile(join(dir, "left.txt"), "x");
    const t = await job(["unused"], dir);
    const error = await rejection(runStageAgent(t.job, reader, sections));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_WORKSPACE_MODIFIED");
    assert.equal(error.message, "The workspace has changes before Reader:\n?? left.txt");
    assert.deepEqual(t.fake.runs, []);
  });

  it("records the workspace after generated agent config", async () => {
    const dir = await ignoringWorkspace("stage-generated-");
    const t = await job([], dir);
    t.fake.deps.runAgent = async (options) => {
      // Like rulesync: generated files are written and excluded before the hook.
      await writeFile(join(dir, "AGENTS.md"), "rules");
      await options.beforeStart?.();
      return { exitCode: 0, finalMessage: "Read." };
    };
    assert.equal(await runStageAgent(t.job, reader, sections), "Read.");
  });

  for (const [where, file] of [
    ["a .gitignore path", "cache/notes.md"],
    ["an info/exclude path", "AGENTS.md"],
  ]) {
    it(`detects a file a read-only role wrote into ${where}`, async () => {
      const dir = await ignoringWorkspace("stage-ignored-");
      const t = await job(
        [
          async () => {
            await mkdir(join(dir, "cache"), { recursive: true });
            await writeFile(join(dir, file), "leftover");
            return "Read.";
          },
        ],
        dir,
      );
      const error = await rejection(runStageAgent(t.job, reader, sections));
      assert.ok(error instanceof StageError);
      assert.equal(error.code, "STAGE_WORKSPACE_MODIFIED");
      assert.equal(error.message, `Reader changed the workspace:\n+ !! ${file}`);
    });
  }

  it("detects an ignored file a read-only role removed", async () => {
    const dir = await ignoringWorkspace("stage-removed-");
    await mkdir(join(dir, "cache"));
    await writeFile(join(dir, "cache", "kept.md"), "x");
    const t = await job(
      [() => rm(join(dir, "cache"), { recursive: true }).then(() => "")],
      dir,
    );
    const error = await rejection(runStageAgent(t.job, reader, sections));
    assert.ok(error instanceof StageError);
    assert.equal(error.message, "Reader changed the workspace:\n- !! cache/kept.md");
  });

  it("fails closed when the workspace was not recorded", async () => {
    const t = await job([]);
    t.fake.deps.runAgent = () => Promise.resolve({ exitCode: 0, finalMessage: "x" });
    const error = await rejection(runStageAgent(t.job, reader, sections));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_WORKSPACE_MODIFIED");
    assert.equal(error.message, "The workspace was not recorded before Reader started");
  });

  it("does not record the workspace for a writing role", async () => {
    const t = await job(["Wrote."]);
    await runStageAgent(t.job, writer, sections);
    assert.equal("beforeStart" in t.fake.runs[0], false);
  });

  it("refuses a read-only role that moved HEAD", async () => {
    const dir = await makeCommittedWorkspace("stage-head-");
    const t = await job(
      [
        () => {
          execFileSync(
            "git",
            ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit"].concat([
              "--quiet",
              "--allow-empty",
              "-m",
              "sneaky",
            ]),
            { cwd: dir },
          );
          return "Done.";
        },
      ],
      dir,
    );
    const error = await rejection(runStageAgent(t.job, reader, sections));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_WORKSPACE_MODIFIED");
    assert.match(error.message, /^Reader moved HEAD from [0-9a-f]+ to [0-9a-f]+$/);
  });

  it("rethrows other agent failures without a login comment", async () => {
    const failure = new AgentError("AGENT_RUN_FAILED", "boom", { exitCode: 2 });
    const t = await job([failure]);
    assert.equal(await rejection(runStageAgent(t.job, reader, sections)), failure);
    assert.deepEqual(t.issues.github.writes(), []);
  });

  it("reads GitHub fresh before and after the agent runs", async () => {
    const t = await job([
      () => {
        // The agent's time passes; GitHub changes meanwhile.
        t.issues.main.labels.push("pause");
        return "done";
      },
      new AgentError("AGENT_RUN_FAILED", "boom", { exitCode: 2 }),
    ]);
    const { client } = t.issues.github;
    const labels = async () =>
      (await readIssueRecord(client, { owner: "acme", repo: "app", number: 1 })).labels;
    assert.deepEqual(await labels(), ["scope"]);
    t.issues.main.labels.push("shaped");
    await runStageAgent(t.job, reader, sections);
    assert.deepEqual(await labels(), ["scope", "shaped", "pause"]);
    t.issues.main.labels.splice(0);
    await rejection(runStageAgent(t.job, reader, sections));
    assert.deepEqual(await labels(), []);
  });

  it("settles the login comment once per Job", async () => {
    const t = await job(["one", "two"]);
    seedComment(t.issues, t.issues.main, "<!-- nibfin:agent-login -->\nLogin expired.");
    await runStageAgent(t.job, reader, sections);
    await runStageAgent(t.job, reader, sections);
    // The Issue record before the write (shared by find and upsert), then its read-back.
    const reads = t.issues.github.calls.filter((call) => call.path === "/graphql");
    assert.equal(reads.length, 2);
    assert.equal(t.issues.github.writes().length, 1);
    assert.equal(t.issues.github.calls.length, 3);
  });
});

describe("readWorkspaceState", () => {
  it("rejects a directory that is not a Git checkout", async () => {
    const dir = await mkdtemp(join(await makeTempDir("not-git-"), "dir-"));
    await writeFile(join(dir, ".git"), "gitdir: missing-git-dir\n");
    const error = await rejection(readWorkspaceState(dir));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_INPUT_INVALID");
    assert.match(error.message, /^NIBFIN_WORKSPACE is not a usable Git checkout: /);
  });
});

describe("prepareStageJob", () => {
  it("checks the host memory before reading the configuration", async () => {
    const issues = fakeIssues(fakeIssue());
    const fake = fakeDeps([]);
    const context = { ...jobContext(workspace), memoryRequired: 64 * 1024 ** 3 };
    const error = await rejection(
      prepareStageJob(context, issues.github.client, fake.deps, []),
    );
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_HOST_MEMORY_LOW");
    assert.deepEqual(fake.configReads, []);
    const enough = { ...context, memoryRequired: 1024 ** 3 };
    await prepareStageJob(enough, issues.github.client, fake.deps, []);
    assert.deepEqual(fake.configReads, [workspace]);
  });

  it("resolves each named skill once, before any run", async () => {
    const issues = fakeIssues(fakeIssue());
    const fake = fakeDeps(["Done."]);
    const context = jobContext(workspace);
    const skills = ["shape", "accept", "shape"] as const;
    const prepared = await prepareStageJob(
      context,
      issues.github.client,
      fake.deps,
      skills,
    );
    assert.deepEqual(fake.skillReads, ["shape", "accept"]);
    assert.equal(await runStageAgent(prepared, reader, sections), "Done.");
    assert.deepEqual(fake.skillReads, ["shape", "accept"]);
  });

  it("keeps the base checkout's extension after the workspace changes", async () => {
    const dir = await makeCommittedWorkspace("stage-skill-base-");
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "docs", "accept.md"), "BASE EXTENSION");
    const issues = fakeIssues(fakeIssue());
    const fake = fakeDeps(["Done."]);
    fake.deps.resolveRoleSkill = defaultStageDeps.resolveRoleSkill;
    fake.deps.readNibfinConfig = () =>
      Promise.resolve({
        tools: {},
        skills: { accept: { mode: "extend", path: "docs/accept.md" } },
      });
    const context = jobContext(dir);
    const prepared = await prepareStageJob(context, issues.github.client, fake.deps, [
      "accept",
    ]);
    // Like checking out a PR head cut before the extension existed.
    await rm(join(dir, "docs"), { recursive: true });
    assert.equal(await runStageAgent(prepared, writer, sections), "Done.");
    assert.match(fake.runs[0]?.prompt ?? "", /\n\nBASE EXTENSION/);
  });
});

describe("runStageAgent without a resolved skill", () => {
  it("refuses a role whose skill the stage did not resolve", async () => {
    const t = await job(["unused"]);
    const shaper: StageRole = { ...reader, skill: "shape" };
    const error = await rejection(runStageAgent(t.job, shaper, sections));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_INPUT_INVALID");
    assert.equal(error.message, "The shape skill was not resolved for Reader");
    assert.deepEqual(t.fake.runs, []);
  });
});

describe("defaultStageDeps", () => {
  it("logs to stdout", (t) => {
    const write = t.mock.method(process.stdout, "write", () => true);
    defaultStageDeps.log("hello");
    assert.deepEqual(write.mock.calls[0]?.arguments, ["hello\n"]);
  });
});
