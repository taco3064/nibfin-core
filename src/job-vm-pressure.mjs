import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateHostDirectory } from './host-fence.mjs';
import { requireThat } from './identity.mjs';

export const writerPressureWait = 'JOB_VM_HOST_MEMORY_PRESSURE';
export const writerInitializeTimeout = 'JOB_VM_EXEC_INITIALIZE_TIMEOUT';
export const retryableWriterPressure = code =>
  code === writerPressureWait || code === writerInitializeTimeout;
const maximumWait = 5 * 60_000;
const pollInterval = 15_000;
const cooldownName = 'writer-pressure-cooldown';

export async function noteWriterTimeout(root) {
  if (!await isWsl()) return;
  await privateHostDirectory(root);
  const handle = await openLock(root, cooldownName);
  try {
    const now = new Date();
    await handle.utimes(now, now);
  } finally { await handle.close(); }
}

export function writerCapacity(meminfo, pressure, buddyinfo, memoryMiB) {
  const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1]) / 1024;
  const stalls = pressure === null ? null :
    Number(/^full avg10=(\d+(?:\.\d+)?)/m.exec(pressure)?.[1]);
  requireThat(Number.isFinite(available) && (stalls === null || Number.isFinite(stalls)),
    'JOB_VM_MEMORY_OBSERVATION_INVALID');
  const largeBlocks = buddyinfo.split('\n').reduce((total, row) => {
    const blocks = /^Node\s+\d+, zone\s+(?:DMA32|Normal)\s+([\d\s]+)$/.exec(row)?.[1];
    if (!blocks) return total;
    return total + blocks.trim().split(/\s+/).slice(7)
      .reduce((count, value) => count + Number(value), 0);
  }, 0);
  const reserve = 256;
  if (available < memoryMiB + reserve || stalls >= 5)
    return { mode: 'wait', available, stalls, largeBlocks };
  const constrained = available < 2 * memoryMiB + reserve || stalls >= 1 ||
    largeBlocks === 0;
  return { mode: constrained ? 'serial' : 'parallel', available, stalls, largeBlocks };
}

async function tryLock(handle, mode, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // flock locks the inherited open file description. The controller keeps
    // its own descriptor until guest teardown, so the kernel also handles crashes.
    const child = spawn('/usr/bin/flock', ['--nonblock', mode, '3'], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      signal,
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || code === 1) resolve(code === 0);
      else reject(Object.assign(new Error('JOB_VM_PRESSURE_LOCK_FAILED'), {
        code: 'JOB_VM_PRESSURE_LOCK_FAILED',
      }));
    });
  });
}

async function openLock(root, name) {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
  const handle = await open(join(root, name), flags, 0o600);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0, 'UNTRUSTED_HOST_STATE');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function isWsl() {
  const kernel = await readFile('/proc/sys/kernel/osrelease', 'utf8');
  return /microsoft.*wsl2/i.test(kernel);
}

async function observe(memoryMiB, root) {
  if (!await isWsl()) return null;
  const [meminfo, pressure, buddyinfo] = await Promise.all([
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/pressure/memory', 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
    readFile('/proc/buddyinfo', 'utf8'),
  ]);
  const sample = writerCapacity(meminfo, pressure, buddyinfo, memoryMiB);
  const timeout = await stat(join(root, cooldownName)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (timeout && Date.now() - timeout.mtimeMs < maximumWait &&
      sample.mode === 'parallel') sample.mode = 'serial';
  return sample;
}

export async function acquireWriterCapacity(config, signal, {
  read = observe, wait = delay, clock = () => performance.now(),
  report = message => console.error(message),
} = {}) {
  let sample = await read(config.memoryMiB, config.pressureRoot);
  if (!sample) return async () => {};
  await privateHostDirectory(config.pressureRoot);
  const deadline = clock() + maximumWait;
  let reported;
  for (;;) {
    signal.throwIfAborted();
    const handle = await openLock(config.pressureRoot, 'writer-pressure.lock');
    let admitted = false;
    try {
      if (sample.mode !== 'wait')
        admitted = await tryLock(handle, sample.mode === 'serial' ? '-x' : '-s', signal);
      if (sample.mode !== reported && (sample.mode !== 'parallel' || !admitted)) {
        reported = sample.mode;
        report(`Nibfin WSL Writer ${sample.mode}: ` +
          `MemAvailable=${Math.floor(sample.available)}MiB, ` +
          `memory PSI full.avg10=${sample.stalls ?? 'unavailable'}, ` +
          `free blocks >=512KiB=${sample.largeBlocks}`);
      }
      if (admitted) return () => handle.close();
    } finally {
      if (!admitted) await handle.close();
    }
    const remaining = deadline - clock();
    if (remaining <= 0)
      throw Object.assign(new Error(writerPressureWait), { code: writerPressureWait });
    await wait(Math.min(pollInterval, remaining), undefined, { signal });
    sample = await read(config.memoryMiB, config.pressureRoot);
  }
}
