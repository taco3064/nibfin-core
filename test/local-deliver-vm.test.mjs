import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { runJobVmWriter } from '../src/job-vm-writer.mjs';

// Exercise the maintained transfer and executor relay with a controlled guest.
// This does not boot Firecracker or establish live KVM behavior.
const outcomes = ['interrupted', 'completed', 'failed-collection', 'failed-install'];
for (const outcome of outcomes) {
  test(`VM workspace retention follows actual collection: ${outcome}`, async t => {
    const scratch = resolve('.deliver-test-tmp');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(scratch, 'vm-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = { executionId: '00000000-0000-4000-8000-000000000001',
      plan: {}, onLocalHandback: () => assert.fail('VM has no host handback'),
      onInterruptedCleanup: () => assert.fail('Outer consumer is not retired') };
    for (const name of ['work', 'main', 'input']) {
      input[name] = join(root, name);
      await mkdir(input[name], { mode: 0o700 });
    }
    await writeFile(join(input.work, 'old.txt'), 'original host workspace');
    const sockets = new Set(), requests = [];
    const guestPath = join(root, 'guest');
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.once('data', bytes => {
        const request = JSON.parse(bytes);
        requests.push(request.operation ?? request.method);
        let response;
        if (request.method === 'initialize')
          response = { id: 1, result: { sessionId: 'controlled-guest' } };
        else if (request.operation === 'prepare') response = { ready: true,
          ...(request.name === 'work' ? { toolOutput: {
            root: request.toolRoot, directories: request.toolDirectories,
            collection: 'preserve-source-omit-owned-output',
          } } : {}) };
        else response = outcome === 'failed-collection' ? {} : { files: [{
          path: outcome === 'failed-install' ? '../unsafe' : 'edit.txt',
          executable: false,
          content: Buffer.from('collected Writer edit').toString('base64'),
        }] };
        socket.write(JSON.stringify(response) + '\n');
      });
    });
    server.listen(guestPath);
    await once(server, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    const disk = join(root, 'private-disk');
    let retained, retired = false, discarded = false;
    const execute = async invocation => {
      assert.equal(invocation.onLocalHandback, undefined);
      assert.equal(invocation.onInterruptedCleanup, undefined);
      await writeFile(disk, 'unreturned Writer edit');
      return { executionId: input.executionId,
        status: outcome === 'interrupted' ? 'interrupted' : 'completed',
        terminationHash: 'a'.repeat(64) };
    };
    const operation = runJobVmWriter({}, input, execute, {
      capacity: async () => async () => {},
      observe: async () => ({ finish: async () => undefined }),
      runVm: async (_config, lifecycle) => {
        try {
          return await lifecycle.useGuest(async () =>
            createConnection({ path: guestPath }), root);
        } finally {
          retained = lifecycle.retainWorkspace();
          if (!retained) await rm(disk);
          await lifecycle.onRetired(async () => {
            await rm(disk);
            discarded = true;
          });
          retired = true;
        }
      },
    });
    if (outcome === 'failed-collection') await assert.rejects(operation,
      { code: 'JOB_VM_WORKSPACE_TRANSFER_FAILED' });
    else {
      const result = await operation;
      assert.equal(result.status, outcome === 'interrupted'
        ? 'interrupted' : 'completed');
      if (outcome === 'failed-install') await assert.rejects(result.applyWorkspace(),
        { code: 'INVALID_JOB_VM_WORKSPACE_ENTRY' });
      if (outcome === 'completed') {
        await result.applyWorkspace();
        assert.equal(await readFile(join(input.work, 'edit.txt'), 'utf8'),
          'collected Writer edit');
      }
    }
    assert.equal(retired, true);
    assert.equal(retained, true);
    assert.equal(discarded, outcome === 'completed');
    if (!discarded) {
      assert.equal(await readFile(disk, 'utf8'), 'unreturned Writer edit');
      assert.equal(await readFile(join(input.work, 'old.txt'), 'utf8'),
        'original host workspace');
    }
    assert.equal(requests.includes('collect'), outcome !== 'interrupted');
  });
}
