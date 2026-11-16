import { spawn } from 'node:child_process';
import { requireThat } from './identity.mjs';

// flock attaches to the inherited open description. Its owner must keep the
// handle open until the callback finishes, then close it to release the lock.
export async function withKernelGate(handle, use, {
  shared = false, busyCode = 'RELAY_BUSY',
} = {}) {
  const args = ['-n', '-E', '75', ...(shared ? ['--shared'] : []), '3'];
  const child = spawn('/usr/bin/flock', args, {
    stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    env: { PATH: '/usr/bin:/bin' },
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', value => { clearTimeout(timer); resolve(value); });
  });
  if (code === 75) return { status: 'pending', code: busyCode };
  requireThat(code === 0, 'RELAY_LOCK_UNAVAILABLE');
  return use();
}
