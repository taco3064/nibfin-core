import { observeHostPressure, hostMemoryPressure } from './host-memory-pressure.mjs';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createProxy, toolDownloadHosts, projectDomains } from './egress-proxy.mjs';
import { runJobVm } from './job-vm.mjs';
import { exchangeJobVmFrame } from './job-vm-channel.mjs';
import {
  jobVmExecutorFailures, openJobVmExecRelay, probeJobVmExecutor,
} from './job-vm-exec-relay.mjs';
import { snapshotJobVmWorkspace } from './job-vm-workspace.mjs';
import { installJobVmWorkspace } from './job-vm-install.mjs';
import { archiveJobVmTools } from './job-vm-tools.mjs';
import { deliveryRoleTimeout } from './process.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';
import {
  acquireWriterCapacity, noteWriterTimeout, writerInitializeTimeout, writerPressureWait,
} from './job-vm-pressure.mjs';

const workspacePort = 4020;
const egressPort = 4022;

async function openJobVmEgress(directory, domains) {
  const server = createProxy({ hosts: [
    ...toolDownloadHosts,
    ...projectDomains(domains),
  ] });
  const clients = new Set();
  server.on('connection', client => {
    if (clients.size >= 32) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.once('close', () => clients.delete(client));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(directory, 'guest.sock_' + egressPort), resolve);
  });
  return () => new Promise((resolve, reject) => {
    for (const client of clients) client.destroy();
    server.close(error => error ? reject(error) : resolve());
  });
}

async function transfer(connect, payload, signal) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = AbortSignal.any([signal, timeout]);
  try {
    return await exchangeJobVmFrame(
      await connect(workspacePort, deadline), payload, deadline);
  } catch (error) {
    // Report the failed boundary without exposing candidate bytes or credentials.
    console.error(`Nibfin VM ${payload.operation} ${payload.name ?? 'work'}: ` +
      (error.code ?? error.name));
    throw error;
  }
}

export async function runJobVmWriter(config, input, execute, {
  runVm = runJobVm, observe = observeHostPressure, capacity = acquireWriterCapacity,
} = {}) {
  const abort = new AbortController();
  const cancel = () => {
    const code = 'JOB_VM_CANCELLED';
    abort.abort(Object.assign(new Error(code), { code }));
  };
  const deadline = AbortSignal.timeout(deliveryRoleTimeout);
  const signal = AbortSignal.any([abort.signal, deadline]);
  // Keep guest-controlled console output off the Action output stream.
  const log = await open('/dev/null', constants.O_WRONLY);
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  let releaseCapacity, monitor, retired = false;
  let agentEntered = false, agentTermination, retireAgentMcp;
  const executeOwned = async invocation => {
    agentEntered = true;
    const result = await execute(invocation);
    if (['completed', 'interrupted'].includes(result?.status) &&
      isDigest(result.terminationHash)) {
      agentTermination = result.terminationHash;
      retireAgentMcp = result.retireMcp;
    }
    return result;
  };
  try {
    releaseCapacity = await capacity(config, signal);
    monitor = await observe(input.pressureBinding);
    const { result, files } = await runVm(config, {
      signal, log,
      onProcess: process => process && monitor.own(process.pid, process.startTicks),
      onRetired: () => { retired = true; },
      prepareTools: input.tools && (directory => archiveJobVmTools(
        input.tools.endpoint, input.tools.image, directory, input.tools.label)),
      async useGuest(connect, directory) {
        const domains = input.plan?.additionalDomains;
        const closeEgress = await openJobVmEgress(directory, domains);
        try {
          return await runWriter(connect, directory, input, executeOwned, signal);
        } finally { await closeEgress(); }
      },
    });
    const memoryPressure = await monitor.finish();
    monitor = undefined;
    if (memoryPressure && retired && result.status === 'interrupted' &&
      isDigest(result.terminationHash))
      return pressureInterruption(input, memoryPressure, result.terminationHash);
    return files ? {
      ...result,
      applyWorkspace: () => installJobVmWorkspace(input.work, files),
    } : result;
  } catch (error) {
    const memoryPressure = await monitor?.finish();
    monitor = undefined;
    if (memoryPressure && retired && (!agentEntered || isDigest(agentTermination))) {
      await retireAgentMcp?.();
      return pressureInterruption(input, memoryPressure, agentTermination);
    }
    // runJobVm rethrows the probe error only after it has retired the guest.
    if (error.code !== writerPressureWait &&
        !jobVmExecutorFailures.includes(error.code)) throw error;
    if (error.code === writerInitializeTimeout)
      await noteWriterTimeout(config.pressureRoot).catch(() => {
        console.error('Nibfin WSL Writer: could not record handshake cooldown');
      });
    return { status: 'interrupted', executionId: input.executionId, code: error.code,
      terminationObservation: { owner: 'vm-adapter',
        executionId: input.executionId, code: error.code },
      terminationHash: digest({ executionId: input.executionId,
        ...(error.code === writerPressureWait ? { guestNotStarted: true } :
          { guestRetired: true }) }) };
  } finally {
    await monitor?.finish();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    try { await releaseCapacity?.(); }
    finally { await log.close(); }
  }
}

async function runWriter(connect, directory, input, execute, signal) {
  const request = payload => transfer(connect, payload, signal);
  for (const name of ['work', 'main', 'input']) {
    const temporary = input.plan.config['shell_environment_policy.set'].TMPDIR;
    const files = await snapshotJobVmWorkspace(input[name], name === 'work'
      ? { temporaryDirectory: temporary.slice('/work/'.length) } : {});
    const setup = await request({ operation: 'prepare', name, files });
    requireThat(setup?.ready === true, 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
  }
  const relay = join(directory, 'exec.sock');
  const close = await openJobVmExecRelay(relay, connect);
  try {
    await probeJobVmExecutor(relay, signal);
    const result = await execute({ ...input, jobVmSocket: relay });
    signal.throwIfAborted();
    if (result.status !== 'completed') return { result };
    const output = await request({ operation: 'collect' });
    requireThat(Array.isArray(output?.files), 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
    return { result, files: output.files };
  } finally { await close(); }
}

function pressureInterruption(input, memoryPressure, agentTermination) {
  return { status: 'interrupted', executionId: input.executionId,
    code: hostMemoryPressure, memoryPressure,
    terminationHash: digest({ executionId: input.executionId, guestRetired: true,
      ...(agentTermination ? { agentTermination } : {}) }),
    terminationObservation: { owner: 'vm-adapter',
      executionId: input.executionId, code: hostMemoryPressure } };
}
