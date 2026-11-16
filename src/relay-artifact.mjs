import { inflateRawSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import { sha256, requireThat, digest } from './identity.mjs';
import {
  managedWakeContract, projectManagedWake, serializeManagedWake,
} from './managed-wake.mjs';
import { relayBounds } from './relay-http.mjs';

// Strict single-entry ZIP reader. No extraction, paths, ZIP64 or trailing data.
export function readRelayArchive(bytes, expectedDigest) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= relayBounds.archiveBytes &&
    bytes.length >= 98 && expectedDigest === `sha256:${sha256(bytes)}`,
  'RELAY_ARTIFACT_DIGEST_MISMATCH');
  const end = bytes.length - 22;
  requireThat(bytes.readUInt32LE(end) === 0x06054b50 &&
    bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 &&
    bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1 &&
    bytes.readUInt16LE(end + 20) === 0, 'RELAY_INVALID_ARCHIVE');
  const centralSize = bytes.readUInt32LE(end + 12);
  const central = bytes.readUInt32LE(end + 16);
  requireThat(central >= 30 && central + centralSize === end && centralSize >= 46 &&
    bytes.readUInt32LE(central) === 0x02014b50 &&
    bytes.readUInt32LE(0) === 0x04034b50, 'RELAY_INVALID_ARCHIVE');
  const flags = bytes.readUInt16LE(central + 8);
  const method = bytes.readUInt16LE(central + 10);
  const crc = bytes.readUInt32LE(central + 16);
  const compressed = bytes.readUInt32LE(central + 20);
  const size = bytes.readUInt32LE(central + 24);
  const nameSize = bytes.readUInt16LE(central + 28);
  const extraSize = bytes.readUInt16LE(central + 30);
  const commentSize = bytes.readUInt16LE(central + 32);
  const mode = bytes.readUInt32LE(central + 38) >>> 16;
  const name = Buffer.from(managedWakeContract.fileName);
  requireThat((flags & ~0x808) === 0 && [0, 8].includes(method) &&
    size > 0 && size <= managedWakeContract.maxBytes &&
    compressed <= relayBounds.archiveBytes && nameSize === name.length &&
    bytes.subarray(central + 46, central + 46 + nameSize).equals(name) &&
    centralSize === 46 + nameSize + extraSize + commentSize &&
    bytes.readUInt16LE(central + 34) === 0 &&
    bytes.readUInt32LE(central + 42) === 0 &&
    [0, 0o100000].includes(mode & 0o170000) &&
    bytes.readUInt16LE(6) === flags && bytes.readUInt16LE(8) === method &&
    bytes.readUInt16LE(26) === nameSize &&
    bytes.subarray(30, 30 + nameSize).equals(name), 'RELAY_INVALID_ARCHIVE');
  const start = 30 + nameSize + bytes.readUInt16LE(28);
  const stop = start + compressed;
  requireThat(stop <= central, 'RELAY_INVALID_ARCHIVE');
  if (flags & 8) {
    const signed = central - stop === 16;
    const descriptor = stop + (signed ? 4 : 0);
    requireThat((signed && bytes.readUInt32LE(stop) === 0x08074b50 ||
      central - stop === 12) && bytes.readUInt32LE(descriptor) === crc &&
      bytes.readUInt32LE(descriptor + 4) === compressed &&
      bytes.readUInt32LE(descriptor + 8) === size, 'RELAY_INVALID_ARCHIVE');
  } else requireThat(stop === central && bytes.readUInt32LE(14) === crc &&
    bytes.readUInt32LE(18) === compressed && bytes.readUInt32LE(22) === size,
  'RELAY_INVALID_ARCHIVE');
  const data = bytes.subarray(start, stop);
  const json = method === 0 ? data : inflateRawSync(data, {
    maxOutputLength: managedWakeContract.maxBytes, info: true,
  });
  const output = method === 0 ? json : json.buffer;
  requireThat(method === 0 || json.engine.bytesWritten === data.length,
    'RELAY_INVALID_ARCHIVE');
  requireThat(output.length === size && crc32(output) === crc,
    'RELAY_INVALID_ARCHIVE');
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

export function readRelayPayload(bytes, origin, runId) {
  const value = JSON.parse(bytes);
  requireThat(value.schemaVersion === 1 && value.runId === runId &&
    value.attempt === 1, 'RELAY_FORGED_PAYLOAD');
  const projected = projectManagedWake(value.event, { eventName: 'issues',
    repository: origin.repository, runId, attempt: 1 });
  requireThat(value.event.repository.id === origin.repositoryId &&
    digest(value) === digest(projected) && bytes === serializeManagedWake(projected),
  'RELAY_FORGED_PAYLOAD');
  return projected;
}
