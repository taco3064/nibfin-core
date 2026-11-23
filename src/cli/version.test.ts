import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readVersion } from "./version.ts";

test("readVersion returns the version from package.json", async () => {
  const manifestUrl = new URL("../../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
    version: string;
  };
  assert.equal(readVersion(), manifest.version);
});
