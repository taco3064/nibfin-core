import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { requireThat } from './identity.mjs';

// Trusted executable/argv only. No shell or inherited credentials/config hooks.
export function command(
  executable,
  args,
  {
    cwd,
    env = {},
    input,
    timeout = 120000,
    limit = 16 * 1024 * 1024,
    allowedExitCodes = [0],
  } = {},
) {
  requireThat(
    typeof executable === 'string' &&
      isAbsolute(executable) &&
      !executable.includes('\0') &&
      Array.isArray(args) &&
      args.every((value) => typeof value === 'string' && !value.includes('\0')) &&
      Number.isSafeInteger(timeout) &&
      timeout > 0 &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      (input === undefined || typeof input === 'string' || Buffer.isBuffer(input)) &&
      Array.isArray(allowedExitCodes) &&
      allowedExitCodes.length > 0 &&
      allowedExitCodes.length <= 256 &&
      allowedExitCodes.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 255,
      ),
    'INVALID_PROCESS_REQUEST',
  );
  const accepted = new Set(allowedExitCodes);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform === 'linux',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [],
      stderr = [];
    let size = 0,
      failure,
      timer,
      hardTimer,
      settled = false,
      exited = false;
    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      child.unref();
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
        });
    };
    const signal = (name) => {
      // Never signal a possibly reused PID/group after the leader has exited.
      if (exited) return;
      try {
        if (process.platform === 'linux') process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        /* Signalling failure proves no termination. */
      }
    };
    const stop = (code) => {
      if (settled || failure) return;
      failure = Object.assign(new Error(code), { code });
      clearTimeout(timer);
      signal('SIGTERM');
      hardTimer = setTimeout(() => {
        signal('SIGKILL');
        // A different UID or retained pipe may survive. Settle transport only;
        // callers must preserve Pending/fences until actual reconciliation.
        finish(failure);
      }, 1000);
    };
    const collect = (target) => (data) => {
      if (failure || settled) return;
      size += data.length;
      if (size > limit) stop('PROCESS_OUTPUT_LIMIT');
      else target.push(data);
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {});
    }
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('exit', () => {
      exited = true;
    });
    child.on('error', () =>
      finish(
        Object.assign(new Error('PROCESS_UNAVAILABLE'), { code: 'PROCESS_UNAVAILABLE' }),
      ),
    );
    child.on('close', (exitCode) => {
      if (failure) finish(failure);
      else if (!accepted.has(exitCode))
        finish(
          Object.assign(new Error('PROCESS_FAILED'), {
            code: 'PROCESS_FAILED',
            exitCode,
          }),
        );
      else finish(null, exitCode);
    });
    timer = setTimeout(() => stop('PROCESS_TIMEOUT'), timeout);
    child.stdin.end(input);
  });
}
