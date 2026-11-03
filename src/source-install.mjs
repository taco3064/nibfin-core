import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, chmod, rename, rm, rmdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, isDigest, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';

// The archive digest and manifest pin come from independently approved public
// provenance. A downloaded manifest cannot approve its own archive or source.
export async function installSource(bytes, destination, expected) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024 && isDigest(expected?.archiveHash) &&
    sha256(bytes) === expected.archiveHash, 'ARCHIVE_PIN_MISMATCH');
  const target = resolve(destination), parent = dirname(target);
  requireThat(target !== parent && await realpath(parent) === parent, 'UNSAFE_INSTALL_DESTINATION');
  try { await lstat(target); throw new Error('INSTALL_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const raw = gunzipSync(bytes, { maxOutputLength: 40 * 1024 * 1024 });
  const entries = [], paths = new Set(); let offset = 0;
  const string = (header, start, length) => header.subarray(start, start + length).toString('ascii').replace(/\0.*$/s, '');
  const octal = (header, start, length) => {
    const value = string(header, start, length).trim(); requireThat(/^[0-7]+$/.test(value), 'INVALID_ARCHIVE_NUMBER');
    return Number.parseInt(value, 8);
  };
  while (offset + 512 <= raw.length && raw.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const header = Buffer.from(raw.subarray(offset, offset + 512)), path = string(header, 0, 100);
    requireThat(/^[A-Za-z0-9._/-]+$/.test(path) && !path.startsWith('/') &&
      path.split('/').every(part => part && !['.', '..', '.git'].includes(part)) && !paths.has(path) &&
      header[156] === 48 && string(header, 157, 100) === '' && string(header, 345, 155) === '' &&
      string(header, 257, 6) === 'ustar' && string(header, 263, 2) === '00', 'UNSAFE_ARCHIVE_ENTRY');
    const checksum = octal(header, 148, 8); header.fill(32, 148, 156);
    requireThat(header.reduce((sum, byte) => sum + byte, 0) === checksum, 'ARCHIVE_CHECKSUM_MISMATCH');
    const size = octal(header, 124, 12), mode = octal(header, 100, 8);
    requireThat([0o644, 0o755].includes(mode) && size <= 32 * 1024 * 1024 && entries.length < 1001 &&
      offset + 512 + Math.ceil(size / 512) * 512 <= raw.length, 'INVALID_ARCHIVE_FILE');
    paths.add(path); entries.push({ path, mode, bytes: raw.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireThat(raw.length - offset >= 1024 && raw.length % 512 === 0 &&
    raw.subarray(offset).every(byte => byte === 0), 'INVALID_ARCHIVE_END');
  const temp = join(parent, `.nibfin-install-${randomUUID()}`);
  await mkdir(temp, { mode: 0o700 });
  try {
    for (const file of entries) {
      const path = join(temp, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: 'wx', mode: file.mode === 0o755 ? 0o500 : 0o400 });
    }
    const source = await verifyInstalledSource(temp, expected);
    // Reserve the final directory exclusively; rename into that reservation can
    // replace only our own empty directory, never another installed version.
    await mkdir(target, { mode: 0o700 });
    try { await rename(temp, target); } catch (error) { await rmdir(target); throw error; }
    await chmod(target, 0o700);
    return source;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
