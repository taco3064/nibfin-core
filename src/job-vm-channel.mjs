import { once } from 'node:events';
import { requireThat } from './identity.mjs';

const frameLimit = 96 * 1024 * 1024;

// Each connection carries one request and one response. Firecracker does not
// require either side to half-close before the other side can send its frame.
export async function exchangeJobVmFrame(socket, request, signal) {
  signal.throwIfAborted();
  const frame = Buffer.from(JSON.stringify(request) + '\n');
  requireThat(frame.length <= frameLimit, 'JOB_VM_REQUEST_TOO_LARGE');
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (!socket.write(frame)) {
      await Promise.race([
        once(socket, 'drain', { signal }),
        once(socket, 'close', { signal }).then(() => {
          throw new Error('JOB_VM_CHANNEL_CLOSED');
        }),
      ]);
    }
    const parts = [];
    let size = 0;
    for await (const bytes of socket) {
      size += bytes.length;
      requireThat(size <= frameLimit, 'JOB_VM_RESPONSE_TOO_LARGE');
      parts.push(bytes);
      const end = bytes.indexOf(10);
      if (end < 0) continue;
      signal.throwIfAborted();
      requireThat(end === bytes.length - 1 && size > 1, 'INVALID_JOB_VM_RESPONSE');
      return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
    }
    signal.throwIfAborted();
    requireThat(false, 'INCOMPLETE_JOB_VM_RESPONSE');
  } finally {
    signal.removeEventListener('abort', abort);
    socket.destroy();
  }
}
