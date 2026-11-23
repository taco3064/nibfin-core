import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childEnvironment } from "./environment.ts";

describe("childEnvironment", () => {
  it("keeps only allowlisted parent variables and adds the extras", () => {
    const allowed = {
      PATH: "/usr/bin",
      HOME: "/home/nibfin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      HTTP_PROXY: "http://proxy:1",
      HTTPS_PROXY: "http://proxy:2",
      NO_PROXY: "localhost",
      http_proxy: "http://proxy:3",
      https_proxy: "http://proxy:4",
      no_proxy: "127.0.0.1",
    };
    const blocked = {
      GITHUB_TOKEN: "fake-github-token",
      GH_TOKEN: "fake-gh-token",
      ACTIONS_RUNTIME_TOKEN: "fake-runtime-token",
      CODEX_HOME: "/parent/codex",
      NODE_OPTIONS: "--require x",
    };
    const extra = { CLAUDE_CONFIG_DIR: "/login/claude" };
    assert.deepEqual(childEnvironment({ ...allowed, ...blocked }, extra), {
      ...allowed,
      ...extra,
    });
  });

  it("lets an extra replace an inherited value", () => {
    assert.deepEqual(childEnvironment({ HOME: "/a" }, { HOME: "/b" }), { HOME: "/b" });
  });

  it("returns only the extras for an empty parent", () => {
    assert.deepEqual(childEnvironment({}, {}), {});
  });
});
