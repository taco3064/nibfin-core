import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { requireThat } from './identity.mjs';

// Trusted executable/argv only. No shell or inherited credentials/config hooks.
export function command(executable, args, { cwd, env = {}, input, timeout = 120000, limit = 16 * 1024 * 1024 } = {}) {
  requireThat(isAbsolute(executable) && Array.isArray(args) && args.every(value => typeof value === 'string' && !value.includes('\0')) &&
    Number.isSafeInteger(timeout) && timeout > 0 && Number.isSafeInteger(limit) && limit > 0, 'INVALID_PROCESS_REQUEST');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let size = 0, failure;
    const stop = code => {
      failure ??= Object.assign(new Error(code), { code });
      try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ }
    };
    const timer = setTimeout(() => stop('PROCESS_TIMEOUT'), timeout);
    const collect = target => data => { size += data.length; if (size > limit) stop('PROCESS_OUTPUT_LIMIT'); else target.push(data); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('PROCESS_UNAVAILABLE'), { code: 'PROCESS_UNAVAILABLE' })); });
    child.on('close', exitCode => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (exitCode !== 0) reject(Object.assign(new Error('PROCESS_FAILED'), { code: 'PROCESS_FAILED', exitCode }));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input);
  });
}
