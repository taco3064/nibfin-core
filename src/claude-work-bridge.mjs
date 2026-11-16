import limits from './claude-work-limits.json' with { type: 'json' };
import { connect } from 'node:net';
import { claudeWorkSocket } from './claude-work-channel.mjs';

// The optional dial is an executor double for component tests. The installed
// executable never receives transport configuration through argv or environment.
export async function runWorkBridge(input, output, endpoint = claudeWorkSocket,
  dial = connect) {
  if (endpoint !== claudeWorkSocket) throw new Error('WORK_ENDPOINT_DENIED');
  input.pause();
  const socket = dial(claudeWorkSocket);
  const sizes = { request: 0, response: 0 };
  const bounds = { request: limits.requestBytes, response: limits.responseBytes };
  const bound = (chunk, direction) => {
    for (const byte of chunk) {
      sizes[direction]++;
      if (sizes[direction] > bounds[direction]) throw new Error('WORK_FRAME_LIMIT');
      if (byte === 10) sizes[direction] = 0;
    }
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
    const ended = () => finish();
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
    socket.on('close', ended);
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
