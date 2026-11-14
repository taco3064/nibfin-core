import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  openJobVmExecRelay, probeJobVmExecutor,
} from '../src/job-vm-exec-relay.mjs';

test('Writer readiness retries a stalled initialize through the relay', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-exec-probe-'));
  const guestPath = join(root, 'guest.sock');
  const relayPath = join(root, 'relay.sock');
  const guests = new Set();
  let attempts = 0;
  const guest = createServer(socket => {
    guests.add(socket);
    socket.on('close', () => guests.delete(socket));
    socket.once('data', bytes => {
      assert.equal(JSON.parse(bytes).method, 'initialize');
      if (++attempts === 1) return;
      socket.write('{"id":1,"result":{"sessionId":"test-session"}}\n');
    });
  });
  let closeRelay;
  try {
    guest.listen(guestPath);
    await once(guest, 'listening');
    closeRelay = await openJobVmExecRelay(relayPath,
      async (_, signal) => createConnection({ path: guestPath, signal }));
    await probeJobVmExecutor(relayPath, AbortSignal.timeout(5000), 150);
    assert.equal(attempts, 2);
    await assert.rejects(
      probeJobVmExecutor(join(root, 'missing.sock'), AbortSignal.timeout(5000), 150),
      { code: 'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE' },
    );
  } finally {
    await closeRelay?.();
    for (const socket of guests) socket.destroy();
    await new Promise(resolve => guest.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
