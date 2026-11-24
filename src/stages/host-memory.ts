import { readFile } from "node:fs/promises";
import { StageError } from "./errors.ts";

const unitBytes: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

/**
 * Bytes of a Podman `--memory` value: a number with an optional unit `b`, `k`, `m`
 * or `g` (binary units); `undefined` when it is not one.
 */
export function parseMemory(value: string): number | undefined {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const bytes = Number(match[1]) * unitBytes[(match[2] ?? "b").toLowerCase()];
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/** `MemAvailable` of a `/proc/meminfo` text, in bytes. */
export function memAvailable(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return match === null ? undefined : Number(match[1]) * 1024;
}

export function readMeminfo(): Promise<string> {
  return readFile("/proc/meminfo", "utf8");
}

/**
 * Before the first agent run: the host must have at least `required` bytes
 * available (`NIBFIN_MEMORY_REQUIRED`, the container's `--memory`), else
 * `STAGE_HOST_MEMORY_LOW`. No requirement means no check.
 */
export async function checkHostMemory(
  required: number | undefined,
  read: () => Promise<string>,
): Promise<void> {
  if (required === undefined) {
    return;
  }
  const available = memAvailable(await read());
  if (available === undefined || available < required) {
    const found = available === undefined ? "unknown" : `${available} bytes`;
    const message =
      `The host has ${found} of memory available; the Job needs ${required} bytes ` +
      "(NIBFIN_MEMORY_REQUIRED). Free memory on the runner host or lower the limit.";
    throw new StageError("STAGE_HOST_MEMORY_LOW", message);
  }
}
