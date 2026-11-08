import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readMcpOwnerAdoption } from './mcp-job-owner.mjs';
import { requireThat } from './identity.mjs';
import { mcpJobChannel } from './mcp-job-channel.mjs';
import { readMcpFrame, encodeMcpFrame, validateMcpRequest } from './mcp-job-codec.mjs';

function exitObservation(child) {
  return new Promise(resolveExit => {
    child.on('error', () => resolveExit(false));
    child.on('close', (code, signal) => resolveExit(code === 0 && signal === null));
  });
}

// Internal child of the outer Windows supervisor. Its only inherited handles
// are private request, response and diagnostic pipes, never the relay write end.
// The outside supervisor owns native termination proof and relay handoff.
export async function armMcpJobBridge() {
  const c = await readMcpOwnerAdoption();
  const env = { SystemRoot: 'C:/Windows' };
  let supervisor, cancelled = false;
  const cancel = () => {
    cancelled = true;
    // Closing the supervisor's input requests Job Object shutdown. The close
    // observation and supervisor proof below remain separate requirements.
    supervisor?.stdin.end();
  };
  const channel = mcpJobChannel(process.stdin, cancel);
  const stop = () => { cancel(); process.stdin.destroy(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const request = validateMcpRequest(await channel.request);
    requireThat(!cancelled && ['repositoryId', 'memberId', 'runnerId'].every(key =>
      c[key] === request.binding[key]), 'MCP_JOB_BRIDGE_BINDING_MISMATCH');
    supervisor = spawn(c.supervisor.path, ['--producer', c.node.path,
      fileURLToPath(new URL('./mcp-job-owner.mjs', import.meta.url)), c.home], {
      env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = exitObservation(supervisor);
    let errorText = '', overflow = false;
    supervisor.stderr.on('data', bytes => {
      if (errorText.length + bytes.length > 16384) {
        overflow = true;
        supervisor.stdin.end();
      } else errorText += bytes.toString('utf8');
    });
    supervisor.stdin.on('error', cancel);
    supervisor.stdin.write(encodeMcpFrame(request));
    const output = await readMcpFrame(supervisor.stdout);
    requireThat(await exited && !cancelled && !overflow &&
      errorText.split(/\r?\n/).includes('NIBFIN_WINDOWS_MCP_TERMINATED') &&
      JSON.stringify(output.binding) === JSON.stringify(request.binding) &&
      output.nonce === request.nonce && output.protocol === request.protocol,
    'MCP_JOB_PRODUCER_TERMINATION_UNPROVEN');
    // The delegated response is released only after the contained producer
    // and its descendants have stopped and the trusted supervisor has exited.
    // Secret bytes take a separate data channel. The outer supervisor sees
    // only the request and a fixed completion marker, never delegated output.
    const upload = spawn(c.wsl.path, ['--distribution', c.distribution,
      '--user', 'root', '--exec', '/usr/bin/perl',
      '/opt/nibfin/core/src/mcp-job-relay.pl', '--response'], {
      env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const uploaded = exitObservation(upload);
    upload.stdin.on('error', cancel);
    let acknowledgement = '', diagnosticSize = 0;
    upload.stdout.on('data', bytes => {
      acknowledgement += bytes.toString();
      if (acknowledgement.length > 64) { cancel(); upload.stdin.destroy(); }
    });
    upload.stderr.on('data', bytes => {
      diagnosticSize += bytes.length;
      if (diagnosticSize > 16384) { cancel(); upload.stdin.destroy(); }
    });
    upload.stdin.end(encodeMcpFrame({ ...output, terminated: true }));
    requireThat(await uploaded && !cancelled &&
      acknowledgement === 'NIBFIN_MCP_RESPONSE_STAGED\n',
    'MCP_JOB_RESPONSE_STAGING_UNPROVEN');
    process.stdout.write('NIBFIN_MCP_BRIDGE_COMPLETE\n');
    process.stdin.destroy();
  } catch {
    cancel();
    process.stdin.destroy();
    // The outer supervisor also contains this bridge and its descendants.
    // Unknown effects retain the endpoint and Job guard; never re-export.
    throw Object.assign(Error('MCP_JOB_BRIDGE_UNRESOLVED'), {
      code: 'MCP_JOB_BRIDGE_UNRESOLVED',
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  armMcpJobBridge().catch(() => {
    process.stderr.write('MCP_JOB_BRIDGE_UNRESOLVED\n');
    process.exitCode = 1;
  });
}
