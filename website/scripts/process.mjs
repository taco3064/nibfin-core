import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, openSync, closeSync, readFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function processGroupAbsent(pid) {
  try { process.kill(-pid, 0); return false; }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

function stopDescendants(pid) {
  if (process.platform !== 'linux' || !pid || processGroupAbsent(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 3000;
  while (!processGroupAbsent(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!processGroupAbsent(pid)) {
    throw Object.assign(new Error('Website child termination unverified'),
      { terminationUnknown: true });
  }
  throw new Error('Website command left descendants running');
}

// Regular files keep diagnostics available without relying on pipe shutdown.
export function runNpm(args, {
  timeout = 120000, env = process.env, cwd = process.cwd(),
} = {}) {
  const parent = tmpdir();
  const directory = mkdtempSync(join(parent, 'website-command-'));
  const paths = ['stdout', 'stderr'].map((name) => join(directory, name));
  const descriptors = [];
  let result;
  try {
    for (const path of paths) descriptors.push(openSync(path, 'wx', 0o600));
    const cli = process.env.npm_execpath;
    const executable = cli ? process.execPath
      : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    result = spawnSync(executable, cli ? [cli, ...args] : args, {
      env, cwd, timeout, killSignal: 'SIGKILL',
      stdio: ['ignore', ...descriptors], windowsHide: true,
      detached: process.platform === 'linux',
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
  const stdout = readFileSync(paths[0], 'utf8');
  const stderr = readFileSync(paths[1], 'utf8');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const failure = result.error?.code === 'ETIMEDOUT'
    ? new Error(`Website command timed out after ${timeout} ms: npm ${args.join(' ')}`,
      { cause: result.error })
    : result.error;
  try { stopDescendants(result.pid); }
  catch (cleanupError) {
    const error = failure
      ? new AggregateError([failure, cleanupError],
        `${failure.message}. ${cleanupError.message}`)
      : cleanupError;
    throw Object.assign(error, {
      terminationUnknown: cleanupError.terminationUnknown,
      recoveryDirectory: directory,
    });
  }
  if (failure) {
    // A timeout does not prove all descendants stopped. Preserve diagnostics.
    throw Object.assign(failure, { recoveryDirectory: directory });
  }
  rmSync(directory, { recursive: true });
  return { ...result, stdout, stderr };
}
