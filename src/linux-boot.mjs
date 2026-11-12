import { readFile } from 'node:fs/promises';
import { requireThat } from './identity.mjs';

export const isBootId = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// Fixed trusted kernel interface; no event, environment or Agent path override.
export async function linuxBootId() {
  requireThat(process.platform === 'linux', 'UNSUPPORTED_BOOT_OBSERVATION');
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  requireThat(isBootId(value), 'INVALID_BOOT_OBSERVATION');
  return value;
}

export async function proveDifferentBoot(previous, observe = linuxBootId) {
  const current = await observe();
  requireThat(isBootId(previous) && isBootId(current) && previous !== current,
    'WRITER_NOT_PROVEN_TERMINATED');
  return current;
}
