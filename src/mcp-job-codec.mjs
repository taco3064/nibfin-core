import { digest, requireThat } from './identity.mjs';
import { validateMcpJob } from './mcp-job.mjs';

export const mcpFrameLimit = 1024 * 1024;

export function mcpRequest(binding, nonce) {
  validateMcpJob(binding);
  requireThat(typeof nonce === 'string' && /^[a-f0-9]{64}$/.test(nonce),
    'INVALID_MCP_JOB_NONCE');
  return { protocol: 'nibfin-mcp-job-v1', binding, nonce };
}

export function validateMcpRequest(value) {
  requireThat(value && Object.keys(value).sort().join(',') ===
    'binding,nonce,protocol' && value.protocol === 'nibfin-mcp-job-v1',
  'INVALID_MCP_JOB_REQUEST');
  return mcpRequest(value.binding, value.nonce);
}

export function validateMcpResponse(value, request) {
  requireThat(value && Object.keys(value).sort().join(',') ===
    'binding,delegation,nativeTerminated,nonce,protocol,terminated' &&
    value.protocol === request.protocol && value.nonce === request.nonce &&
    digest(validateMcpJob(value.binding)) === digest(request.binding) &&
    value.terminated === true && value.nativeTerminated === true,
  'INVALID_MCP_JOB_RESPONSE');
  return value.delegation;
}

export function encodeMcpFrame(value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  requireThat(bytes.length <= mcpFrameLimit, 'MCP_JOB_FRAME_TOO_LARGE');
  return bytes;
}

// EOF must follow exactly one frame. Do not accept the first valid prefix and
// ignore a duplicate, unsolicited response or an incomplete trailing frame.
export async function readMcpFrame(stream) {
  const parts = [];
  let size = 0;
  for await (const bytes of stream) {
    size += bytes.length;
    requireThat(size <= mcpFrameLimit, 'MCP_JOB_FRAME_TOO_LARGE');
    parts.push(Buffer.from(bytes));
  }
  const bytes = Buffer.concat(parts);
  requireThat(bytes.length > 1 && bytes.at(-1) === 10 &&
    bytes.indexOf(10) === bytes.length - 1, 'INVALID_MCP_JOB_FRAME');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { requireThat(false, 'INVALID_MCP_JOB_FRAME'); }
  return value;
}
