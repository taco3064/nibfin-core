import { observeHostPressure, hostMemoryPressure } from './host-memory-pressure.mjs';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createProxy, toolDownloadHosts, projectDomains } from './egress-proxy.mjs';
import { runJobVm } from './job-vm.mjs';
import { guestWorkspace } from './job-vm-guest-workspace.mjs';
import {
  jobVmExecutorFailures, openJobVmExecRelay, probeJobVmExecutor,
} from './job-vm-exec-relay.mjs';
import {
  jobVmShellPort, probeJobVmShell, quiesceJobVmShell,
} from './job-vm-shell.mjs';
import { snapshotJobVmWorkspace } from './job-vm-workspace.mjs';
import { projectToolDirectories, projectToolRoot } from './project-tool-paths.mjs';
import { installJobVmWorkspace } from './job-vm-install.mjs';
import { buildJobVmPayload } from './job-vm-tools.mjs';
import { deliveryRoleTimeout } from './process.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';
import {
  acquireWriterCapacity, noteWriterTimeout, writerInitializeTimeout, writerPressureWait,
} from './job-vm-pressure.mjs';

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

export async function runJobVmWriter(config, input, execute, {
  runVm = runJobVm, observe = observeHostPressure, capacity = acquireWriterCapacity,
  provider = 'codex',
} = {}) {
  // The adopted provider selects the guest route; Codex is the default.
  requireThat(['codex', 'claude'].includes(provider) &&
    (input.plan?.provider ?? 'codex') === provider, 'INVALID_AGENT_PLAN');
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
  let agentEntered = false;
  let agentTermination, retireAgentMcp, discardWorkspace;
  const executeOwned = async invocation => {
    agentEntered = true;
    // Inner Docker cleanup proves no host-workspace handback for a VM Writer.
    const result = await execute({ ...invocation, onLocalHandback: undefined,
      onInterruptedCleanup: undefined });
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
      onRetired: discard => { retired = true; discardWorkspace = discard; },
      retainWorkspace: () => agentEntered,
      prepareTools: directory => buildJobVmPayload(
        directory, input.executorSnapshot, input.tools),
      async useGuest(connect, directory) {
        const domains = input.plan?.additionalDomains;
        const closeEgress = await openJobVmEgress(directory, domains);
        try {
          return await runWriter(connect, directory, input, executeOwned, signal,
            provider);
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
      applyWorkspace: async () => {
        await installJobVmWorkspace(input.work, files);
        await discardWorkspace?.();
      },
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

async function runWriter(connect, directory, input, execute, signal, provider) {
  const workspace = guestWorkspace(connect, signal);
  const output = {
    directories: (input.plan?.toolDirectories ??
      projectToolDirectories(true)).map(path => path.slice(6)),
    root: (input.plan?.toolRoot ?? projectToolRoot(true)).slice(6),
  };
  for (const name of ['work', 'main', 'input']) {
    const files = await snapshotJobVmWorkspace(input[name]);
    await workspace.prepare(name, files, name === 'work' ? output : undefined);
  }
  // Claude gets only its guest shell socket; Codex only the exec-server socket.
  const claude = provider === 'claude';
  const relay = join(directory, claude ? 'shell.sock' : 'exec.sock');
  const close = claude ? await openJobVmExecRelay(relay, connect, jobVmShellPort) :
    await openJobVmExecRelay(relay, connect);
  try {
    if (claude) await probeJobVmShell(relay, signal);
    else await probeJobVmExecutor(relay, signal);
    const result = await execute({ ...input, jobVmSocket: relay });
    signal.throwIfAborted();
    if (result.status !== 'completed') return { result };
    if (claude) await quiesceJobVmShell(connect, signal);
    return { result, files: await workspace.collect() };
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
