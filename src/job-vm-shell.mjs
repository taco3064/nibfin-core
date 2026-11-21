import { createConnection } from 'node:net';
import { exchangeJobVmFrame } from './job-vm-channel.mjs';
import { shellExchange } from './claude-vm-shell.mjs';
import { requireThat } from './identity.mjs';

// Claude only: the guest shell endpoint beside Codex's exec port 4021.
export const jobVmShellPort = 4023;
const readiness = 'NIBFIN_SHELL_READY';

// Per-execution Claude readiness: a real command round trip through the relay.
// The guest runs every command in its own cgroup and refuses without
// cgroup.kill, so a pass also proves the kill mechanism exists. Failures reuse
// the executor code; the diagnostic names the actual reason.
export async function probeJobVmShell(path, signal, timeout = 30_000) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  let stdout = '';
  try {
    const result = await shellExchange(createConnection({ path }), {
      operation: 'run', script: `printf ${readiness}`, cwd: '/work', env: {},
    }, { signal: deadline, stdout: bytes => { stdout += bytes; } });
    requireThat(result.code === 0 && stdout === readiness, 'JOB_VM_SHELL_INVALID');
  } catch (error) {
    signal.throwIfAborted();
    const reason = /^JOB_VM_SHELL_[A-Z_]+$/.test(error.code ?? '') ? error.code :
      'JOB_VM_SHELL_UNAVAILABLE';
    console.error(`Nibfin Writer shell probe: ${reason}`);
    const code = 'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE';
    throw Object.assign(new Error(code), { code, reason });
  }
}

// After the agent ends and before collection: no command cgroup may survive,
// and the guest accepts no further command.
export async function quiesceJobVmShell(connect, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const connection = await connect(jobVmShellPort, deadline);
  const reply = await exchangeJobVmFrame(connection, { operation: 'quiesce' },
    deadline);
  requireThat(reply?.quiesced === true, 'JOB_VM_SHELL_QUIESCE_FAILED');
}
