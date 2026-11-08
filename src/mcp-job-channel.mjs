import { requireThat } from './identity.mjs';
import { mcpFrameLimit } from './mcp-job-codec.mjs';

// Read one request without treating its delimiter as process termination.
// Keep monitoring the stream after admission: EOF cancels, more bytes reject.
export function mcpJobChannel(stream, cancel) {
  let buffer = Buffer.alloc(0), admitted = false, failed = false;
  let resolve, reject;
  const request = new Promise((yes, no) => { resolve = yes; reject = no; });
  const fail = () => {
    if (failed) return;
    failed = true;
    reject(Object.assign(Error('MCP_JOB_CHANNEL_CLOSED'), {
      code: 'MCP_JOB_CHANNEL_CLOSED',
    }));
    cancel();
  };
  stream.on('data', bytes => {
    try {
      requireThat(!admitted && !failed, 'DUPLICATE_MCP_JOB_FRAME');
      buffer = Buffer.concat([buffer, bytes]);
      requireThat(buffer.length <= mcpFrameLimit, 'MCP_JOB_FRAME_TOO_LARGE');
      const end = buffer.indexOf(10);
      if (end < 0) return;
      requireThat(end === buffer.length - 1, 'DUPLICATE_MCP_JOB_FRAME');
      const value = JSON.parse(buffer.toString('utf8'));
      admitted = true;
      buffer.fill(0);
      resolve(value);
    } catch { fail(); }
  });
  stream.on('end', fail);
  stream.on('error', fail);
  return { request, get cancelled() { return failed; } };
}
