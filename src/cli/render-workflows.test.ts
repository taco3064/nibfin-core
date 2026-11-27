import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { renderWorkflows } from "../workflows/index.ts";
import { capture } from "./fake-io.test.ts";
import { renderWorkflowsCommand } from "./render-workflows.ts";

const digest = `ghcr.io/taco3064/nibfin@sha256:${"0".repeat(64)}`;

describe("nibfin render-workflows", () => {
  it("prints the rendered files as one JSON object", async () => {
    const result = await capture([
      "render-workflows",
      "--set",
      "execution",
      "--channel",
      "user",
      "--image",
      digest,
      "--default-branch",
      "trunk",
      "--workflow",
      "CI",
      "--workflow",
      "Build",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.endsWith("}\n"));
    const expected = renderWorkflows({
      set: "execution",
      channel: "user",
      image: digest,
      defaultBranch: "trunk",
      workflows: ["Build", "CI"],
    });
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout) as object), [
      ".github/workflows/nibfin-issue.yml",
      ".github/workflows/nibfin-job.yml",
      ".github/workflows/nibfin-runner-request.yml",
      ".github/workflows/nibfin-shared-runner.yml",
    ]);
  });

  it("renders a peer set without an image", async () => {
    const result = await capture([
      "render-workflows",
      "--set=peer",
      "--channel=own",
      "--default-branch=main",
    ]);
    assert.equal(result.code, 0);
    const files = JSON.parse(result.stdout) as Record<string, string>;
    assert.deepEqual(Object.keys(files), [
      ".github/workflows/nibfin-e2e-notify.yml",
      ".github/workflows/nibfin-issue.yml",
    ]);
    assert.ok(!files[".github/workflows/nibfin-issue.yml"].includes("workflow_run:"));
  });

  const invalid: [string, string[], RegExp][] = [
    ["no options", [], /^nibfin: WORKFLOW_INPUT_INVALID: set "" is not/],
    [
      "a missing default branch",
      ["--set", "peer", "--channel", "user"],
      /default branch "" is empty/,
    ],
    [
      "an invalid image for a peer set",
      ["--set", "peer", "--channel", "user", "--default-branch", "main", "--image", "x"],
      /image "x" is not/,
    ],
    ["an unknown option", ["--set", "peer", "--force"], /Unknown option '--force'/],
    ["a positional argument", ["peer"], /Unexpected argument 'peer'/],
  ];
  for (const [name, args, message] of invalid) {
    it(`fails on ${name} with empty stdout`, async () => {
      const result = await capture(["render-workflows", ...args]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, message);
      assert.ok(result.stderr.startsWith("nibfin: ") && result.stderr.endsWith("\n"));
    });
  }
});

describe("renderWorkflowsCommand template errors", () => {
  let views: string;
  before(async () => {
    views = await makeTempDir("render-command-");
  });
  after(() => rm(views, { recursive: true, force: true }));

  it("fails with empty stdout when a template is missing", () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    };
    const args = ["--set", "peer", "--channel", "user", "--default-branch", "main"];
    assert.equal(renderWorkflowsCommand(args, io, views), 1);
    assert.deepEqual(out, []);
    assert.match(
      err.join(""),
      /^nibfin: Could not find template: .*nibfin-issue\.yml\.eta\n$/,
    );
  });
});
