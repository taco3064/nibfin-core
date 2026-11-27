import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { coreWorkflowRequest, writeCoreWorkflows } from "./core.ts";
import { renderWorkflows } from "./render.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("./regenerate.ts", import.meta.url));

describe("Core's committed workflow files", () => {
  const rendered = renderWorkflows(coreWorkflowRequest);

  it("are exactly the rendered set", async () => {
    const names = await readdir(join(repoRoot, ".github/workflows"));
    const committed = names.filter((name) => /^nibfin-.*\.yml$/.test(name)).sort();
    const expected = Object.keys(rendered).map((path) => path.split("/").at(-1));
    assert.deepEqual(committed, expected);
  });

  for (const [path, content] of Object.entries(rendered)) {
    it(`${path} equals its render (run npm run render:workflows)`, async () => {
      assert.equal(await readFile(join(repoRoot, path), "utf8"), content);
    });
  }
});

describe("writeCoreWorkflows", () => {
  let root: string;
  before(async () => {
    root = await makeTempDir("core-workflows-");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("writes the rendered files and deletes nothing", async () => {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/ci.yml"), "name: CI\n");
    await writeFile(join(root, ".github/workflows/nibfin-job.yml"), "stale\n");
    const rendered = renderWorkflows(coreWorkflowRequest);
    assert.deepEqual(await writeCoreWorkflows(root), Object.keys(rendered));
    for (const [path, content] of Object.entries(rendered)) {
      assert.equal(await readFile(join(root, path), "utf8"), content);
    }
    assert.equal(
      await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
      "name: CI\n",
    );
  });

  it("is what npm run render:workflows runs, in the current directory", async () => {
    const cwd = await makeTempDir("core-workflows-entry-");
    try {
      const result = spawnSync(process.execPath, [entry], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const paths = Object.keys(renderWorkflows(coreWorkflowRequest));
      assert.equal(result.stdout, paths.map((path) => `Wrote ${path}\n`).join(""));
      const written = await readdir(join(cwd, ".github/workflows"));
      assert.equal(written.length, paths.length);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
