import { requireThat } from '../identity.mjs';

// Runner 2.338.2 ProcessChannel/StreamString use two little endian int32s
// followed by a UTF-16LE body. Retain all later bytes for Worker cancellation.
export async function readWorkerFrame(source) {
  const header = await readExactly(source, 8);
  const length = header.readInt32LE(4);
  requireThat(header.readInt32LE(0) === 1 && length > 0 &&
    length <= 50_000_000 && length % 2 === 0, 'SHARED_WORKER_FRAME_INVALID');
  const body = await readExactly(source, length);
  const message = JSON.parse(new TextDecoder('utf-16le', { fatal: true }).decode(body));
  return { header, body, message };
}

async function readExactly(source, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await source.read(buffer, offset, size - offset, null);
    requireThat(bytesRead !== 0, 'SHARED_WORKER_FRAME_TRUNCATED');
    offset += bytesRead;
  }
  return buffer;
}
