import { connect } from 'node:net';
import { lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat, isId } from './identity.mjs';
import { mcpRequest, encodeMcpFrame, readMcpFrame,
  validateMcpResponse } from './mcp-job-codec.mjs';

const socketPath = '/run/nibfin-mcp/job.sock';

export async function inspectMcpJobEndpoint(source) {
  requireThat(process.platform === 'linux' && source?.kind === 'native-job-v1' &&
    Object.keys(source).sort().join(',') === 'controllerGid,kind' &&
    source.controllerGid === process.getgid(), 'UNSUPPORTED_MCP_JOB_TRANSPORT');
  await rootOwnedPath('/run/nibfin-mcp');
  const stat = await lstat(socketPath);
  requireThat(stat.isSocket() && stat.uid === 0 &&
    stat.gid === source.controllerGid && (stat.mode & 0o777) === 0o660,
  'MCP_JOB_BRIDGE_NOT_ARMED');
}

// EOF only closes the protocol. Positive relay absence is independently
// observed. EPERM establishes existence only. Wait for ESRCH or cancellation.
export async function waitMcpRelayAbsent(pid, { signal } = {}) {
  requireThat(isId(pid), 'INVALID_MCP_RELAY_PID');
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      requireThat(error.code === 'EPERM' && signal,
        'MCP_JOB_RELAY_TERMINATION_UNPROVEN');
    }
    await setTimeout(20, undefined, { signal });
  }
}

export async function acquireNativeJobMcp(source, binding, { signal } = {}) {
  await inspectMcpJobEndpoint(source);
  signal?.throwIfAborted();
  const request = mcpRequest(binding, randomBytes(32).toString('hex'));
  const socket = connect({ path: socketPath, allowHalfOpen: true });
  const abort = () => socket.end();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((yes, no) => {
      socket.once('connect', yes);
      socket.once('error', no);
    });
    let header = Buffer.alloc(0), relayPid;
    const response = async function* () {
      for await (const bytes of socket) {
        if (relayPid !== undefined) { yield bytes; continue; }
        header = Buffer.concat([header, bytes]);
        requireThat(header.length <= 1024 * 1024, 'INVALID_MCP_RELAY_GREETING');
        const end = header.indexOf(10);
        if (end < 0) continue;
        const greeting = JSON.parse(header.subarray(0, end).toString('utf8'));
        requireThat(Object.keys(greeting).join(',') === 'relayPid' &&
          isId(greeting.relayPid), 'INVALID_MCP_RELAY_GREETING');
        relayPid = greeting.relayPid;
        if (header.length > end + 1) yield header.subarray(end + 1);
      }
    };
    signal?.throwIfAborted();
    socket.write(encodeMcpFrame(request));
    const frame = await readMcpFrame(response());
    socket.end();
    const delegation = validateMcpResponse(frame, request);
    await waitMcpRelayAbsent(relayPid, { signal });
    signal?.throwIfAborted();
    // Native proof arrives only through the outer supervisor's private write
    // channel. It is independently required by validateMcpResponse, before
    // relay absence can complete admission. Neither EOF nor producer proof
    // alone can authorize the profile.
    return delegation;
  } finally {
    signal?.removeEventListener('abort', abort);
    socket.destroy();
  }
}
