import limits from './claude-work-limits.json' with { type: 'json' };
import { connect } from 'node:net';
import { claudeWorkSocket } from './claude-work-transport.mjs';

// The optional dial is an executor double for component tests. The installed
// executable never receives transport configuration through argv or environment.
export async function runWorkBridge(input, output, endpoint = claudeWorkSocket,
  dial = connect) {
  if (endpoint !== claudeWorkSocket) throw new Error('WORK_ENDPOINT_DENIED');
  if (process.env.ANTHROPIC_API_KEY) throw new Error('WORK_CREDENTIAL_DENIED');
  input.pause();
  const socket = dial(claudeWorkSocket);
  const pending = new Set();
  const buffers = { request: Buffer.alloc(0), response: Buffer.alloc(0) };
  const bounds = { request: limits.requestBytes, response: limits.responseBytes };
  const bound = (chunk, direction) => {
    let buffer = Buffer.concat([buffers[direction], chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline + 1 > bounds[direction]) throw new Error('WORK_FRAME_LIMIT');
      const frame = JSON.parse(buffer.subarray(0, newline).toString());
      if (!frame || typeof frame !== 'object' || Array.isArray(frame))
        throw new Error('WORK_FRAME_INVALID');
      if (direction === 'request' && frame.method === limits.completionMethod)
        throw new Error('WORK_COMPLETION_RESERVED');
      if (direction === 'request' && Object.hasOwn(frame, 'id')) {
        if (pending.has(frame.id) || pending.size >= limits.pendingRequests)
          throw new Error('WORK_REQUEST_INVALID');
        pending.add(frame.id);
      } else if (direction === 'response') {
        if (!pending.delete(frame.id)) throw new Error('WORK_RESPONSE_INVALID');
      }
      buffer = buffer.subarray(newline + 1);
    }
    if (buffer.length > bounds[direction]) throw new Error('WORK_FRAME_LIMIT');
    buffers[direction] = buffer;
  };
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      input.pause();
      input.removeListener('data', request);
      input.removeListener('error', failed);
      input.removeListener('end', ended);
      output.removeListener('error', failed);
      output.removeListener('drain', responseDrain);
      socket.removeListener('drain', requestDrain);
      socket.destroy();
      if (error) reject(new Error('WORK_CHANNEL_UNAVAILABLE'));
      else resolve();
    };
    const failed = () => finish(true);
    const ended = () => {
      if (buffers.request.length || buffers.response.length || pending.size) {
        failed();
        return;
      }
      // Only the fixed bridge can mark an orderly, fully exchanged EOF.
      // Reserve this notification above so model stdin cannot forge it.
      socket.end(JSON.stringify({ jsonrpc: '2.0',
        method: limits.completionMethod }) + '\n', () => finish());
    };
    const requestDrain = () => { if (!settled) input.resume(); };
    const responseDrain = () => { if (!settled) socket.resume(); };
    const forward = (chunk, direction, source, target, drain) => {
      if (settled) return;
      try {
        bound(chunk, direction);
        if (!target.write(chunk)) {
          source.pause();
          target.once('drain', drain);
        }
      } catch { failed(); }
    };
    const request = chunk => forward(chunk, 'request', input, socket, requestDrain);
    socket.setTimeout((limits.commandSeconds + 5) * 1000, failed);
    socket.on('error', failed);
    socket.on('close', failed);
    socket.on('data', chunk => forward(chunk, 'response', socket, output, responseDrain));
    input.on('error', failed);
    output.on('error', failed);
    input.on('end', ended);
    socket.on('connect', () => {
      input.on('data', request);
      input.resume();
    });
  });
}
