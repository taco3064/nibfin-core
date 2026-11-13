import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export const jobVmExecPort = 4021;


// Mount only this socket in the Codex container. It can initiate an executor
// session but the guest has no connection back to the controller.
export async function openJobVmExecRelay(path, connect) {
  const sessions = new Set();
  const server = createServer(async client => {
    sessions.add(client);
    client.once('close', () => sessions.delete(client));
    client.on('error', () => client.destroy());
    try {
      const guest = await connect(jobVmExecPort, AbortSignal.timeout(60_000));
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
    server.listen(path, resolve);
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
