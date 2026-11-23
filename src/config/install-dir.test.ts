import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "./errors.ts";
import { makeTempDir } from "./fixtures.test.ts";
import { installOnce } from "./install-dir.ts";

let root: string;
before(async () => {
  root = await makeTempDir("config-install-dir-");
});
after(() => rm(root, { recursive: true, force: true }));

describe("installOnce", () => {
  it("fails when the rename fails and no other Job finished", async () => {
    // The temporary directory vanishes before the rename, so it cannot be moved.
    const install = (dir: string) => rm(dir, { recursive: true });
    await assert.rejects(
      installOnce(root, "node", "1.2.3", install),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.code === "TOOL_INSTALL_FAILED" &&
        error.message.startsWith("Could not install node 1.2.3: ") &&
        (error.cause as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.deepEqual(await readdir(join(root, "node")), []);
  });

  it("reports an unusable tool directory as an install failure", async () => {
    const cache = await mkdtemp(join(root, "cache-"));
    await writeFile(join(cache, "go"), "not a directory");
    await assert.rejects(
      installOnce(cache, "go", "1.24.2", () => assert.fail("install must not run")),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.code === "TOOL_INSTALL_FAILED" &&
        error.message.startsWith("Could not install go 1.24.2: ") &&
        error.cause instanceof Error,
    );
  });
});
