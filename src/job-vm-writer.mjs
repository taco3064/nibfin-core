import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { runJobVm } from './job-vm.mjs';
import { exchangeJobVmFrame } from './job-vm-channel.mjs';
import { openJobVmExecRelay } from './job-vm-exec-relay.mjs';
import { snapshotJobVmWorkspace } from './job-vm-workspace.mjs';
import { installJobVmWorkspace } from './job-vm-install.mjs';
import { deliveryRoleTimeout } from './process.mjs';
import { requireThat } from './identity.mjs';

const workspacePort = 4020;

async function transfer(connect, payload, signal) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = AbortSignal.any([signal, timeout]);
  return exchangeJobVmFrame(await connect(workspacePort, deadline), payload, deadline);
}

export async function runJobVmWriter(config, input, execute) {
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('JOB_VM_CANCELLED'));
  const deadline = AbortSignal.timeout(deliveryRoleTimeout);
  const signal = AbortSignal.any([abort.signal, deadline]);
  // Keep guest-controlled console output off the Action output stream.
  const log = await open('/dev/null', constants.O_WRONLY);
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    const { result, files } = await runJobVm(config, {
      signal, log, async useGuest(connect, directory) {
        const request = payload => transfer(connect, payload, signal);
        const trees = {};
        for (const name of ['work', 'main', 'input']) {
          trees[name] = await snapshotJobVmWorkspace(input[name]);
        }
        const setup = await request({ operation: 'prepare', trees });
        requireThat(setup?.ready === true, 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
        const relay = join(directory, 'exec.sock');
        const close = await openJobVmExecRelay(relay, connect);
        try {
          const result = await execute({ ...input, jobVmSocket: relay });
          signal.throwIfAborted();
          if (result.status !== 'completed') return { result };
          const output = await request({ operation: 'collect' });
          requireThat(Array.isArray(output?.files), 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
          return { result, files: output.files };
        } finally { await close(); }
      },
    });
    if (files) await installJobVmWorkspace(input.work, files);
    return { ...result };
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    await log.close();
  }
}
