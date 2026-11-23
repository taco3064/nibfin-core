import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { AgentError } from "../agent/index.ts";
import { rejection } from "../github/fake-github.test.ts";
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

async function job(steps: Parameters<typeof fakeDeps>[0], dir = workspace) {
  const issues = fakeIssues(fakeIssue());
  const fake = fakeDeps(steps, { tools: {}, skills: {} });
  const prepared = await prepareStageJob(
    jobContext(dir),
    issues.github.client,
    fake.deps,
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
    assert.equal(
      error.message,
      "The workspace has changes before Reader:\n?? left.txt\n",
    );
    assert.deepEqual(t.fake.runs, []);
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

  it("settles the login comment once per Job", async () => {
    const t = await job(["one", "two"]);
    seedComment(t.issues, t.issues.main, "<!-- nibfin:agent-login -->\nLogin expired.");
    await runStageAgent(t.job, reader, sections);
    await runStageAgent(t.job, reader, sections);
    const reads = t.issues.github.calls.filter(
      (call) => call.method === "GET" && call.path.endsWith("/comments"),
    );
    assert.equal(reads.length, 3);
    assert.equal(t.issues.github.writes().length, 1);
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

describe("defaultStageDeps", () => {
  it("logs to stdout", (t) => {
    const write = t.mock.method(process.stdout, "write", () => true);
    defaultStageDeps.log("hello");
    assert.deepEqual(write.mock.calls[0]?.arguments, ["hello\n"]);
  });
});
