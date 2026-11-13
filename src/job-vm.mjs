import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { access, chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { privateHostDirectory } from './host-fence.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';

async function copyDisk(source, destination, signal) {
  // The immutable backing file stays outside the VM. Reflinks avoid copying
  // unchanged blocks on supported filesystems, and sparse copies work on ext4.
  await promisify(execFile)('/usr/bin/cp',
    ['--reflink=auto', '--sparse=always', '--', source, destination],
    { env: { PATH: '/usr/bin:/bin' }, signal });
  await chmod(destination, 0o600);
  signal.throwIfAborted();
}

async function checkAsset(path) {
  await rootOwnedPath(path);
  const stat = await lstat(path);
  requireThat(stat.isFile(), 'JOB_VM_ASSET_NOT_FILE');
}

const parentGuard = '/usr/bin/setpriv';

function startGuest(executable, config, directory, log) {
  const child = spawn(parentGuard, [
    '--pdeathsig', 'SIGKILL', '--no-new-privs', '--',
    executable, '--no-api', '--config-file', config,
  ], {
    cwd: directory,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', log.fd, log.fd],
  });
  let exited = false;
  const done = new Promise(resolve => {
    let error;
    child.on('error', value => { error = value; });
    child.once('close', (exitCode, termination) => {
      exited = true;
      resolve({ error, exitCode, termination });
    });
  });
  return {
    done,
    get exited() { return exited; },
    stop() { if (!exited) child.kill('SIGKILL'); },
  };
}

async function connectGuest(path, port, guest, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (guest.exited) {
      const { error, exitCode, termination } = await guest.done;
      const code = 'JOB_VM_EXITED_BEFORE_HANDOFF';
      throw Object.assign(new Error(code, { cause: error }), {
        code, exitCode, termination,
      });
    }
    const socket = createConnection({ path });
    const abort = () => socket.destroy(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const reply = await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('JOB_VM_CHANNEL_CLOSED')));
        socket.setTimeout(5000, () => {
          socket.destroy(new Error('JOB_VM_HANDSHAKE_TIMEOUT'));
        });
        socket.once('connect', () => socket.write('CONNECT ' + port + '\n'));
        let pending = Buffer.alloc(0);
        const handshake = bytes => {
          pending = Buffer.concat([pending, bytes]);
          const end = pending.indexOf(10);
          if (end < 0 && pending.length <= 32) return;
          socket.pause();
          socket.removeListener('data', handshake);
          if (end < 0 || end > 32 ||
            !/^OK [0-9]+$/.test(pending.subarray(0, end).toString('ascii'))) {
            reject(new Error('JOB_VM_CHANNEL_REJECTED'));
            return;
          }
          if (end + 1 < pending.length) socket.unshift(pending.subarray(end + 1));
          socket.setTimeout(0);
          resolve(socket);
        };
        socket.on('data', handshake);
      });
      signal.throwIfAborted();
      return reply;
    } catch (error) {
      socket.destroy();
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) &&
        !['JOB_VM_CHANNEL_CLOSED', 'JOB_VM_HANDSHAKE_TIMEOUT'].includes(error.message))
        throw error;
      await delay(100, undefined, { signal });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}

export async function preflightJobVm(config) {
  const { executable, kernel, rootDisk, stateRoot, memoryMiB } = config;
  requireThat(process.platform === 'linux' && Number.isSafeInteger(memoryMiB) &&
    memoryMiB >= 128 && memoryMiB <= 8192, 'INVALID_JOB_VM_CONFIGURATION');
  await Promise.all([parentGuard, executable, kernel, rootDisk].map(checkAsset));
  await privateHostDirectory(stateRoot);
  await access(executable, constants.X_OK);
  for (const device of ['/dev/kvm', '/dev/vhost-vsock']) {
    await access(device, constants.R_OK | constants.W_OK).catch(cause => {
      const code = 'JOB_VM_DEVICE_UNAVAILABLE';
      throw Object.assign(new Error(code, { cause }), { code });
    });
  }
}

// Boot a prepared image with a private writable disk. The caller owns the Job
// lifetime. The guest can receive connections through its private vsock endpoint.
export async function runJobVm({ executable, kernel, rootDisk, stateRoot, memoryMiB },
  { signal, log, useGuest }) {
  requireThat(signal, 'INVALID_JOB_VM_CONFIGURATION');
  signal.throwIfAborted();
  await preflightJobVm({ executable, kernel, rootDisk, stateRoot, memoryMiB });
  signal.throwIfAborted();
  const directory = await mkdtemp(join(stateRoot, 'job-vm-'));
  let guest;
  const connections = new Set();
  const abort = () => {
    for (const socket of connections) socket.destroy();
    guest?.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const disk = join(directory, 'root.ext4');
    const config = join(directory, 'vm.json');
    const channel = join(directory, 'guest.sock');
    await copyDisk(rootDisk, disk, signal);
    await writeFile(config, JSON.stringify({
      'boot-source': {
        kernel_image_path: kernel,
        boot_args: 'quiet console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw',
      },
      drives: [{
        drive_id: 'root', path_on_host: disk, is_root_device: true, is_read_only: false,
      }],
      'machine-config': { vcpu_count: 1, mem_size_mib: memoryMiB },
      ...(useGuest ? { vsock: {
        guest_cid: randomInt(3, 0x7fffffff), uds_path: 'guest.sock',
      } } : {}),
    }), { flag: 'wx', mode: 0o600 });
    signal.throwIfAborted();
    guest = startGuest(executable, config, directory, log);
    if (signal.aborted) abort();
    if (useGuest) {
      const startup = AbortSignal.timeout(60_000);
      let connected = false;
      return await useGuest(async (port, requestSignal = signal) => {
        requireThat(Number.isInteger(port) && port > 1023 && port <= 65535,
          'INVALID_JOB_VM_PORT');
        const lifetime = AbortSignal.any(
          connected ? [signal, requestSignal] : [signal, requestSignal, startup]);
        const socket = await connectGuest(channel, port, guest, lifetime);
        connected = true;
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
        return socket;
      }, directory);
    }
    const { error, exitCode, termination } = await guest.done;
    signal.throwIfAborted();
    if (error) throw error;
    if (exitCode !== 0) throw Object.assign(new Error('JOB_VM_EXIT_FAILED'), {
      code: 'JOB_VM_EXIT_FAILED', exitCode, termination,
    });
  } finally {
    signal.removeEventListener('abort', abort);
    abort();
    await guest?.done;
    await rm(directory, { recursive: true, force: true });
  }
}
