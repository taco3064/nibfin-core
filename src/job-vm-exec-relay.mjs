import { createConnection, createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { exchangeJobVmFrame } from './job-vm-channel.mjs';
import { requireThat } from './identity.mjs';

export const jobVmExecPort = 4021;
export const jobVmExecutorFailures = Object.freeze([
  'JOB_VM_EXEC_INITIALIZE_TIMEOUT',
  'JOB_VM_EXEC_INITIALIZE_INVALID',
  'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE',
]);

export async function probeJobVmExecutor(path, signal, attemptTimeout = 10_000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal.throwIfAborted();
    const started = performance.now();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeout)]);
    const socket = createConnection({ path });
    try {
      const reply = await exchangeJobVmFrame(socket, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientName: 'nibfin-readiness' },
      }, deadline);
      requireThat(reply?.id === 1 && typeof reply.result?.sessionId === 'string' &&
        reply.result.sessionId.length > 0, 'JOB_VM_EXEC_INITIALIZE_INVALID');
      return;
    } catch (error) {
      signal.throwIfAborted();
      const code = deadline.aborted ? 'JOB_VM_EXEC_INITIALIZE_TIMEOUT' :
        error.code === 'JOB_VM_EXEC_INITIALIZE_INVALID' ? error.code :
          'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE';
      const elapsed = Math.round(performance.now() - started);
      console.error(`Nibfin Writer executor probe ${attempt}/2: ${code} (${elapsed}ms)`);
      if (attempt === 2 || code === 'JOB_VM_EXEC_INITIALIZE_INVALID')
        throw Object.assign(new Error(code), { code });
    } finally {
      socket.destroy();
    }
  }
}

// Mount only this socket in the Codex container. It can initiate an executor
// session but the guest has no connection back to the controller.
export async function openJobVmExecRelay(path, connect) {
  const sessions = new Set();
  const server = createServer(async client => {
    const session = new AbortController();
    sessions.add(client);
    client.once('close', () => {
      sessions.delete(client);
      session.abort();
    });
    client.on('error', () => client.destroy());
    try {
      const deadline = AbortSignal.any([session.signal, AbortSignal.timeout(60_000)]);
      const guest = await connect(jobVmExecPort, deadline);
      if (client.destroyed) {
        guest.destroy();
        return;
      }
      await Promise.all([pipeline(client, guest), pipeline(guest, client)]);
    } catch {
      client.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const close = async () => {
    for (const socket of sessions) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => {
      if (error) reject(error);
      else resolve();
    }));
    await unlink(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  };
  try {
    // Parent directory is controller-private. Docker maps the file into the
    // adopted role container as a read-only bind.
    await chmod(path, 0o666);
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
