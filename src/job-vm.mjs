import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';

async function copyDisk(source, destination, signal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(destination, 'wx', 0o600);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        signal.throwIfAborted();
        let written = 0;
        while (written < chunk.length) {
          const result = await output.write(chunk, written, chunk.length - written);
          requireThat(result.bytesWritten > 0, 'JOB_VM_DISK_WRITE_FAILED');
          written += result.bytesWritten;
        }
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function checkAsset(path) {
  await rootOwnedPath(path);
  const stat = await lstat(path);
  requireThat(stat.isFile(), 'JOB_VM_ASSET_NOT_FILE');
}

function runGuest(executable, config, directory, log, signal) {
  signal.throwIfAborted();
  const child = spawn(executable, ['--no-api', '--config-file', config], {
    cwd: directory,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', log.fd, log.fd],
  });
  const abort = () => child.kill('SIGKILL');
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return new Promise((resolve, reject) => {
    let error;
    child.on('error', value => { error = value; });
    child.once('close', (code, termination) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(Object.assign(new Error('JOB_VM_EXIT_FAILED'), {
        code: 'JOB_VM_EXIT_FAILED', exitCode: code, termination,
      }));
    });
  });
}

// Boot a prepared image with a private writable disk. The caller owns the Job
// lifetime. No host directory, socket, or network interface is exposed here.
export async function runJobVm({ executable, kernel, rootDisk, stateRoot, memoryMiB },
  { signal, log }) {
  requireThat(process.platform === 'linux' && Number.isSafeInteger(memoryMiB) &&
    memoryMiB >= 128 && signal, 'INVALID_JOB_VM_CONFIGURATION');
  signal.throwIfAborted();
  await Promise.all([executable, kernel, rootDisk].map(checkAsset));
  signal.throwIfAborted();
  await privateHostDirectory(stateRoot);
  const directory = await mkdtemp(join(stateRoot, 'job-vm-'));
  try {
    const disk = join(directory, 'root.ext4');
    const config = join(directory, 'vm.json');
    await copyDisk(rootDisk, disk, signal);
    await writeFile(config, JSON.stringify({
      'boot-source': {
        kernel_image_path: kernel,
        boot_args: 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw',
      },
      drives: [{
        drive_id: 'root', path_on_host: disk, is_root_device: true, is_read_only: false,
      }],
      'machine-config': { vcpu_count: 1, mem_size_mib: memoryMiB },
    }), { flag: 'wx', mode: 0o600 });
    await runGuest(executable, config, directory, log, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
