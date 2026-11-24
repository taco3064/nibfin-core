import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import {
  checkHostMemory,
  memAvailable,
  parseMemory,
  readMeminfo,
} from "./host-memory.ts";

const meminfo = (kb: number) =>
  `MemTotal:       16000000 kB\nMemAvailable:   ${kb} kB\nSwapTotal: 0 kB\n`;

describe("parseMemory", () => {
  it("reads Podman memory values in binary units", () => {
    assert.equal(parseMemory("3g"), 3 * 1024 ** 3);
    assert.equal(parseMemory("2560M"), 2560 * 1024 ** 2);
    assert.equal(parseMemory("512k"), 512 * 1024);
    assert.equal(parseMemory("100b"), 100);
    assert.equal(parseMemory(" 4096 "), 4096);
    for (const bad of ["", "3x", "-1g", "1.5g", "0", "99999999999999999g"]) {
      assert.equal(parseMemory(bad), undefined, bad);
    }
  });
});

describe("checkHostMemory", () => {
  it("does nothing without a requirement", async () => {
    await checkHostMemory(undefined, () => Promise.reject(new Error("not read")));
  });

  it("passes when enough memory is available", async () => {
    await checkHostMemory(3 * 1024 ** 3, () => Promise.resolve(meminfo(4 * 1024 ** 2)));
    await checkHostMemory(1024, () => Promise.resolve(meminfo(1)));
  });

  it("stops with STAGE_HOST_MEMORY_LOW below the requirement", async () => {
    const error = await rejection(
      checkHostMemory(3 * 1024 ** 3, () => Promise.resolve(meminfo(1024 ** 2))),
    );
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_HOST_MEMORY_LOW");
    assert.match(error.message, /1073741824 bytes of memory available/);
  });

  it("stops when MemAvailable is missing", async () => {
    const error = await rejection(checkHostMemory(1, () => Promise.resolve("x")));
    assert.ok(error instanceof StageError);
    assert.match(error.message, /has unknown of memory/);
    assert.equal(memAvailable("MemFree: 1 kB"), undefined);
  });

  it("reads /proc/meminfo where the host has one", async () => {
    try {
      assert.notEqual(memAvailable(await readMeminfo()), undefined);
    } catch (error) {
      assert.equal((error as { code?: string }).code, "ENOENT");
    }
  });
});
