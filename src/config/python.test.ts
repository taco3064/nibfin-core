import assert from "node:assert/strict";
import { readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ProcessRequest } from "../agent/process.ts";
import { ConfigError } from "./errors.ts";
import {
  fakeFetch,
  fakeRun,
  fakeTar,
  makeJobDirs,
  makeTempDir,
  parentSecrets,
  sha256,
  unusedFetch,
  withParentEnvironment,
  writeTree,
} from "./fixtures.test.ts";
import { isWithin } from "./paths.ts";
import { prepareTools } from "./tools.ts";

let root: string;
let restoreEnvironment: () => void;
before(async () => {
  root = await makeTempDir("config-python-");
  restoreEnvironment = withParentEnvironment({
    ...parentSecrets,
    UV_PYTHON_INSTALL_MIRROR: "https://mirror.invalid/",
  });
});
after(async () => {
  restoreEnvironment();
  await rm(root, { recursive: true, force: true });
});

const executable = "cpython-3.13.7-linux-x86_64-gnu/bin/python3.13";

/** A fake `uv` that installs into `UV_PYTHON_INSTALL_DIR` and finds `found`. */
function fakeUv(found?: (installDir: string) => string) {
  return async (request: ProcessRequest) => {
    const installDir = request.env.UV_PYTHON_INSTALL_DIR!;
    if (request.args[1] === "install") {
      await writeTree(installDir, { [executable]: "python" });
      return {};
    }
    const path = found?.(installDir) ?? join(installDir, executable);
    return { stdout: `${path}\n` };
  };
}

async function failure(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.code, "TOOL_INSTALL_FAILED");
    return error;
  }
  assert.fail("expected TOOL_INSTALL_FAILED");
}

describe("prepareTools for Python", () => {
  it("installs through uv with every uv config ignored", async () => {
    const runner = fakeRun(fakeUv());
    const { workspace, cacheDir } = await makeJobDirs(root);
    const options = { workspace, cacheDir, fetch: unusedFetch, run: runner.run };
    const entries = await prepareTools({ python: "3.13.7" }, options);
    const final = join(cacheDir, "python", "3.13.7");
    assert.deepEqual(entries, [join(final, "bin")]);
    for (const name of ["python", "python3"]) {
      const link = await readlink(join(final, "bin", name));
      assert.ok(!isAbsolute(link));
      assert.equal(await readFile(join(final, "bin", name), "utf8"), "python");
    }
    assert.deepEqual(
      runner.requests.map((request) => request.args),
      [
        ["python", "install", "3.13.7"],
        ["python", "find", "--managed-python", "3.13.7"],
      ],
    );
    for (const request of runner.requests) {
      const temp = request.cwd;
      assert.deepEqual(request.command, { command: "uv", args: [] });
      assert.ok(isWithin(join(cacheDir, "python"), temp));
      assert.ok(!isWithin(workspace, temp));
      assert.equal(request.env.UV_NO_CONFIG, "1");
      assert.equal(request.env.UV_PYTHON_INSTALL_DIR, join(temp, "install"));
      assert.equal(request.env.UV_PYTHON_BIN_DIR, join(temp, "uv-bin"));
      assert.equal(request.env.UV_PYTHON_INSTALL_MIRROR, undefined);
      assert.equal(request.env.GITHUB_TOKEN, undefined);
      assert.equal(request.env.GH_TOKEN, undefined);
    }
  });

  it("runs the configured uv executable", async () => {
    const runner = fakeRun(fakeUv());
    const uv = { command: "/opt/uv", args: ["--quiet"] };
    const options = { ...(await makeJobDirs(root)), run: runner.run };
    await prepareTools({ python: "3.13.7" }, { ...options, executables: { uv } });
    assert.deepEqual(runner.requests[0].command, uv);
  });

  it("rejects a find result that is not a path", async () => {
    const runner = fakeRun(fakeUv(() => "no python found"));
    const { cacheDir, ...dirs } = await makeJobDirs(root);
    const error = await failure(
      prepareTools({ python: "3.13.7" }, { ...dirs, cacheDir, run: runner.run }),
    );
    assert.match(error.message, /printed "no python found", not a path$/);
    assert.deepEqual(await readdir(join(cacheDir, "python")), []);
  });

  it("rejects an interpreter outside the new installation", async () => {
    const elsewhere = join(root, "system-python");
    await writeFile(elsewhere, "system");
    const runner = fakeRun(fakeUv(() => elsewhere));
    const dirs = await makeJobDirs(root);
    const error = await failure(
      prepareTools({ python: "3.13.7" }, { ...dirs, run: runner.run }),
    );
    assert.match(error.message, /outside the new installation$/);
  });

  it("reports a failed uv install", async () => {
    const runner = fakeRun(() => ({
      status: { exitCode: 2, signal: null },
      stdout: "",
      stderr: "error: No download found for request: cpython-3.99.0",
    }));
    const dirs = await makeJobDirs(root);
    const error = await failure(
      prepareTools({ python: "3.99.0" }, { ...dirs, run: runner.run }),
    );
    assert.match(error.message, /uv python install 3\.99\.0 failed with exit code 2: /);
    assert.equal(runner.requests.length, 1);
  });

  it("returns entries in Node.js, Python, Go order", async () => {
    const nodeBase = "https://nodejs.org/dist/v22.15.0/";
    const nodeFile = "node-v22.15.0-linux-x64.tar.gz";
    const goFile = "go1.24.2.linux-amd64.tar.gz";
    const release = {
      version: "go1.24.2",
      files: [
        {
          filename: goFile,
          os: "linux",
          arch: "amd64",
          kind: "archive",
          sha256: sha256("go"),
        },
      ],
    };
    const publisher = fakeFetch({
      [`${nodeBase}SHASUMS256.txt`]: { body: `${sha256("node")}  ${nodeFile}\n` },
      [`${nodeBase}${nodeFile}`]: { body: "node" },
      "https://go.dev/dl/?mode=json&include=all": { body: JSON.stringify([release]) },
      [`https://go.dev/dl/${goFile}`]: { body: "go" },
    });
    const uv = fakeUv();
    const tar = fakeTar({ "bin/tool": "" });
    const runner = fakeRun((request) =>
      request.command.command === "uv" ? uv(request) : tar(request),
    );
    const dirs = await makeJobDirs(root);
    const tools = { go: "1.24.2", python: "3.13.7", node: "22.15.0" };
    const options = { ...dirs, fetch: publisher.fetch, run: runner.run, arch: "x64" };
    assert.deepEqual(await prepareTools(tools, options), [
      join(dirs.cacheDir, "node", "22.15.0", "bin"),
      join(dirs.cacheDir, "python", "3.13.7", "bin"),
      join(dirs.cacheDir, "go", "1.24.2", "bin"),
    ]);
  });
});
