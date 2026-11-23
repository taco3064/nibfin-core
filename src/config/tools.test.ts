import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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
import type { FetchLike, RunTool } from "./install-context.ts";
import { isWithin } from "./paths.ts";
import { prepareTools } from "./tools.ts";

let root: string;
let restoreEnvironment: () => void;
before(async () => {
  root = await makeTempDir("config-tools-");
  restoreEnvironment = withParentEnvironment(parentSecrets);
});
after(async () => {
  restoreEnvironment();
  await rm(root, { recursive: true, force: true });
});

const nodeBase = "https://nodejs.org/dist/v22.15.0/";
const nodeFile = "node-v22.15.0-linux-x64.tar.gz";
const nodeArchive = "fake node archive";
const goList = "https://go.dev/dl/?mode=json&include=all";

function nodeRoutes(archive = nodeArchive, file = nodeFile) {
  const sums = `${sha256("other")}  node-v22.15.0.tar.gz\n${sha256(archive)}  ${file}\n`;
  return {
    [`${nodeBase}SHASUMS256.txt`]: { body: sums },
    [`${nodeBase}${file}`]: { body: nodeArchive },
  };
}

function goRelease(version: string, archive: string, extra: object[] = []) {
  const file = (arch: string) => ({
    filename: `${version}.linux-${arch}.tar.gz`,
    os: "linux",
    arch,
    version,
    sha256: sha256(archive),
    size: archive.length,
    kind: "archive",
  });
  const source = { ...file(""), filename: `${version}.src.tar.gz`, kind: "source" };
  return {
    version,
    stable: true,
    files: [...extra, source, file("amd64"), file("arm64")],
  };
}

function goRoutes(releases: unknown, archives: Record<string, string>) {
  const routes: Record<string, { body?: string; redirectTo?: string }> = {
    [goList]: { body: JSON.stringify(releases) },
  };
  for (const [filename, body] of Object.entries(archives)) {
    const google = `https://dl.google.com/go/${filename}`;
    routes[`https://go.dev/dl/${filename}`] = { redirectTo: google };
    routes[google] = { body };
  }
  return routes;
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

interface Setup {
  fetch?: FetchLike;
  run?: RunTool;
  arch?: string;
}

async function job(setup: Setup = {}) {
  const dirs = await makeJobDirs(root);
  const options = { ...dirs, arch: "x64", ...setup };
  return { ...dirs, options };
}

describe("prepareTools for Node.js", () => {
  it("installs a verified archive and returns its bin directory", async () => {
    const publisher = fakeFetch(nodeRoutes());
    let archive = "";
    const tar = fakeTar({ "bin/node": "node" });
    const runner = fakeRun(async (request) => {
      archive = await readFile(request.args[1], "utf8");
      await tar(request);
    });
    const { workspace, cacheDir, options } = await job({
      fetch: publisher.fetch,
      run: runner.run,
    });
    const entries = await prepareTools({ node: "22.15.0" }, options);
    const final = join(cacheDir, "node", "22.15.0");
    assert.deepEqual(entries, [join(final, "bin")]);
    assert.equal(await readFile(join(final, "bin", "node"), "utf8"), "node");
    assert.deepEqual(await readdir(join(cacheDir, "node")), ["22.15.0"]);
    assert.deepEqual(await readdir(final), ["bin"]);
    assert.equal(archive, nodeArchive);
    assert.deepEqual(publisher.urls, [
      `${nodeBase}SHASUMS256.txt`,
      `${nodeBase}${nodeFile}`,
    ]);
    const [request] = runner.requests;
    assert.equal(runner.requests.length, 1);
    assert.deepEqual(request.command, { command: "tar", args: [] });
    const temp = request.cwd;
    assert.deepEqual(request.args, [
      "-xzf",
      join(temp, ".nibfin-download.tar.gz"),
      "-C",
      temp,
      "--strip-components=1",
      "--no-same-owner",
    ]);
    assert.ok(isWithin(join(cacheDir, "node"), temp));
    assert.ok(!isWithin(workspace, temp));
    assert.equal(request.env.GITHUB_TOKEN, undefined);
    assert.equal(request.env.GH_TOKEN, undefined);
  });

  it("uses the arm64 archive on arm64", async () => {
    const file = "node-v22.15.0-linux-arm64.tar.gz";
    const publisher = fakeFetch(nodeRoutes(nodeArchive, file));
    const runner = fakeRun(fakeTar({ "bin/node": "" }));
    const { options } = await job({ fetch: publisher.fetch, run: runner.run });
    await prepareTools({ node: "22.15.0" }, { ...options, arch: "arm64" });
    assert.equal(publisher.urls[1], `${nodeBase}${file}`);
  });

  it("rejects an archive whose checksum does not match", async () => {
    const publisher = fakeFetch(nodeRoutes("a different archive"));
    const runner = fakeRun();
    const { cacheDir, options } = await job({ fetch: publisher.fetch, run: runner.run });
    const error = await failure(prepareTools({ node: "22.15.0" }, options));
    assert.match(error.message, /^Could not install node 22\.15\.0: .* has sha256 /);
    assert.ok(error.cause instanceof Error);
    assert.equal(runner.requests.length, 0);
    assert.deepEqual(await readdir(join(cacheDir, "node")), []);
  });

  it("rejects a version nodejs.org does not publish", async () => {
    const { options } = await job({ fetch: fakeFetch({}).fetch });
    const error = await failure(prepareTools({ node: "99.0.0" }, options));
    assert.match(error.message, /SHASUMS256\.txt answered HTTP 404$/);
  });

  it("rejects a release without a checksum for the archive", async () => {
    const routes = nodeRoutes(nodeArchive, "node-v22.15.0-linux-x64.tar.xz");
    const { options } = await job({ fetch: fakeFetch(routes).fetch });
    const error = await failure(prepareTools({ node: "22.15.0" }, options));
    assert.match(error.message, /no published checksum for node-v22\.15\.0-linux-x64/);
  });

  it("rejects an unsupported architecture", async () => {
    const { options } = await job({ fetch: unusedFetch, arch: "ia32" });
    const node = await failure(prepareTools({ node: "22.15.0" }, options));
    assert.match(node.message, /unsupported architecture ia32$/);
    const go = await failure(prepareTools({ go: "1.24.2" }, options));
    assert.match(go.message, /unsupported architecture ia32$/);
  });

  it("reuses an installed version without downloading", async () => {
    const publisher = fakeFetch(nodeRoutes());
    const runner = fakeRun(fakeTar({ "bin/node": "" }));
    const { cacheDir, options } = await job({ fetch: publisher.fetch, run: runner.run });
    await prepareTools({ node: "22.15.0" }, options);
    const again = await prepareTools(
      { node: "22.15.0" },
      { ...options, fetch: unusedFetch },
    );
    assert.deepEqual(again, [join(cacheDir, "node", "22.15.0", "bin")]);
    assert.equal(runner.requests.length, 1);
  });

  it("ignores another Job's interrupted temporary directory", async () => {
    const runner = fakeRun(fakeTar({ "bin/node": "complete" }));
    const { cacheDir, options } = await job({
      fetch: fakeFetch(nodeRoutes()).fetch,
      run: runner.run,
    });
    const stale = join(cacheDir, "node", ".22.15.0-stale");
    await writeTree(stale, { "bin/node": "partial" });
    const [entry] = await prepareTools({ node: "22.15.0" }, options);
    assert.equal(await readFile(join(entry, "node"), "utf8"), "complete");
    assert.deepEqual((await readdir(join(cacheDir, "node"))).toSorted(), [
      ".22.15.0-stale",
      "22.15.0",
    ]);
  });

  it("uses the other Job's result after a rename collision", async () => {
    const dirs = await makeJobDirs(root);
    const final = join(dirs.cacheDir, "node", "22.15.0");
    const tar = fakeTar({ "bin/node": "mine" });
    const runner = fakeRun(async (request) => {
      await tar(request);
      await writeTree(final, { "bin/node": "theirs" });
    });
    const options = { ...dirs, arch: "x64", fetch: fakeFetch(nodeRoutes()).fetch };
    const entries = await prepareTools(
      { node: "22.15.0" },
      { ...options, run: runner.run },
    );
    assert.deepEqual(entries, [join(final, "bin")]);
    assert.equal(await readFile(join(final, "bin", "node"), "utf8"), "theirs");
    assert.deepEqual(await readdir(join(dirs.cacheDir, "node")), ["22.15.0"]);
  });

  it("reports a failed extraction with its output and removes the temp dir", async () => {
    const runner = fakeRun(() => ({
      status: { exitCode: 2, signal: null },
      stdout: "",
      stderr: "tar: short read\n",
    }));
    const { cacheDir, options } = await job({
      fetch: fakeFetch(nodeRoutes()).fetch,
      run: runner.run,
    });
    const error = await failure(prepareTools({ node: "22.15.0" }, options));
    assert.match(error.message, /tar -xzf .* failed with exit code 2: tar: short read$/);
    assert.deepEqual(await readdir(join(cacheDir, "node")), []);
  });

  it("keeps a non-Error failure as the cause", async () => {
    const run: RunTool = () => {
      // A non-Error rejection.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "spawn failed";
    };
    const { options } = await job({ fetch: fakeFetch(nodeRoutes()).fetch, run });
    const error = await failure(prepareTools({ node: "22.15.0" }, options));
    assert.equal(error.message, "Could not install node 22.15.0: spawn failed");
    assert.equal(error.cause, "spawn failed");
  });
});

describe("prepareTools for Go", () => {
  const releases = [
    goRelease("go1.21.0", "go 1.21.0"),
    goRelease("go1.20.1", "go 1.20.1"),
    goRelease("go1.20", "go 1.20", [
      {
        filename: "../evil.tar.gz",
        os: "linux",
        arch: "amd64",
        kind: "archive",
        sha256: sha256("go 1.20"),
      },
    ]),
  ];
  const archives = {
    "go1.21.0.linux-amd64.tar.gz": "go 1.21.0",
    "go1.20.linux-amd64.tar.gz": "go 1.20",
  };

  it("installs the exact release through the go.dev redirect", async () => {
    const publisher = fakeFetch(goRoutes(releases, archives));
    const runner = fakeRun(fakeTar({ "bin/go": "go" }));
    const { cacheDir, options } = await job({ fetch: publisher.fetch, run: runner.run });
    const entries = await prepareTools({ go: "1.21.0" }, options);
    assert.deepEqual(entries, [join(cacheDir, "go", "1.21.0", "bin")]);
    assert.deepEqual(publisher.urls, [
      goList,
      "https://go.dev/dl/go1.21.0.linux-amd64.tar.gz",
      "https://dl.google.com/go/go1.21.0.linux-amd64.tar.gz",
    ]);
  });

  it("accepts x.y only for a release named exactly go<x.y>", async () => {
    const publisher = fakeFetch(goRoutes(releases, archives));
    const runner = fakeRun(fakeTar({ "bin/go": "go" }));
    const { cacheDir, options } = await job({ fetch: publisher.fetch, run: runner.run });
    const entries = await prepareTools({ go: "1.20" }, options);
    assert.deepEqual(entries, [join(cacheDir, "go", "1.20", "bin")]);
    const error = await failure(prepareTools({ go: "1.21" }, options));
    assert.match(error.message, /go1\.21 is not in the go\.dev release list$/);
  });

  it("uses the arm64 archive on arm64", async () => {
    const arm = { "go1.21.0.linux-arm64.tar.gz": "go 1.21.0" };
    const publisher = fakeFetch(goRoutes(releases, arm));
    const runner = fakeRun(fakeTar({ "bin/go": "go" }));
    const { options } = await job({
      fetch: publisher.fetch,
      run: runner.run,
      arch: "arm64",
    });
    await prepareTools({ go: "1.21.0" }, options);
    assert.equal(publisher.urls[1], "https://go.dev/dl/go1.21.0.linux-arm64.tar.gz");
  });

  it("rejects a download that is not followed through the redirect", async () => {
    const publisher = fakeFetch(goRoutes(releases, archives));
    const noFollow: FetchLike = (url, init) =>
      publisher.fetch(url, { ...init, redirect: "manual" });
    const { options } = await job({ fetch: noFollow, run: fakeRun().run });
    const error = await failure(prepareTools({ go: "1.21.0" }, options));
    assert.match(error.message, /answered HTTP 302$/);
  });

  it("rejects a mismatched checksum", async () => {
    const wrong = { "go1.21.0.linux-amd64.tar.gz": "tampered" };
    const { options } = await job({ fetch: fakeFetch(goRoutes(releases, wrong)).fetch });
    const error = await failure(prepareTools({ go: "1.21.0" }, options));
    assert.match(error.message, /has sha256 .*, not the published /);
  });

  it("rejects an unexpected release list or a release without an archive", async () => {
    const notList = await job({ fetch: fakeFetch(goRoutes({}, {})).fetch });
    const listError = await failure(prepareTools({ go: "1.21.0" }, notList.options));
    assert.match(listError.message, /unexpected release list$/);
    const bare = [{ version: "go1.22.0" }, "noise", { version: "go1.23.0", files: [1] }];
    const { options } = await job({ fetch: fakeFetch(goRoutes(bare, {})).fetch });
    const noFiles = await failure(prepareTools({ go: "1.22.0" }, options));
    assert.match(noFiles.message, /go1\.22\.0 has no linux-amd64 archive$/);
    const noArchive = await failure(prepareTools({ go: "1.23.0" }, options));
    assert.match(noArchive.message, /go1\.23\.0 has no linux-amd64 archive$/);
  });
});

describe("prepareTools", () => {
  it("unpacks a real archive with the system tar", async () => {
    const source = await mkdtemp(join(root, "archive-"));
    await writeTree(source, { "node-v22.15.0-linux-x64/bin/node": "real node" });
    const tarball = join(source, "node.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", source, "node-v22.15.0-linux-x64"]);
    const bytes = await readFile(tarball);
    const sums = `${sha256(bytes)}  ${nodeFile}\n`;
    const publisher = fakeFetch({
      [`${nodeBase}SHASUMS256.txt`]: { body: sums },
      [`${nodeBase}${nodeFile}`]: { body: bytes },
    });
    const { cacheDir, options } = await job({ fetch: publisher.fetch });
    const [entry] = await prepareTools({ node: "22.15.0" }, options);
    assert.equal(entry, join(cacheDir, "node", "22.15.0", "bin"));
    assert.equal(await readFile(join(entry, "node"), "utf8"), "real node");
    assert.deepEqual(await readdir(join(cacheDir, "node", "22.15.0")), ["bin"]);
  });

  it("returns no entries when no tool is declared", async () => {
    const { options } = await job();
    assert.deepEqual(await prepareTools({}, { ...options, arch: undefined }), []);
  });

  it("refuses a cache inside the workspace without creating it", async () => {
    const { workspace } = await job();
    const cacheDir = join(workspace, "cache");
    const error = await failure(prepareTools({}, { workspace, cacheDir }));
    assert.equal(
      error.message,
      `The tool cache ${cacheDir} must be outside the workspace`,
    );
    assert.deepEqual(await readdir(workspace), []);
    const same = await failure(prepareTools({}, { workspace, cacheDir: workspace }));
    assert.match(same.message, /must be outside the workspace$/);
  });

  it("refuses a cache that resolves into the workspace", async () => {
    const { workspace, cacheDir } = await job();
    await symlink(workspace, cacheDir, "dir");
    await failure(prepareTools({}, { workspace, cacheDir }));
  });

  it("reports an unusable cache with the original cause", async () => {
    const { workspace, cacheDir } = await job();
    await writeFile(cacheDir, "not a directory");
    const error = await failure(prepareTools({}, { workspace, cacheDir }));
    assert.match(error.message, /^Could not prepare the tool cache /);
    assert.ok(error.cause instanceof Error);
  });

  it("rechecks versions before they reach cache paths or URLs", async () => {
    const { cacheDir, options } = await job({ fetch: unusedFetch });
    const error = await failure(prepareTools({ node: "../22.15.0" }, options));
    assert.equal(error.message, 'Could not install node: "../22.15.0" is not a version');
    assert.equal(existsSync(cacheDir), false);
  });
});
