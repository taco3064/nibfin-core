import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

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
  const parent = resolve('.npm');
  mkdirSync(parent, { recursive: true });
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
  try { stopDescendants(result.pid); }
  catch (error) {
    throw Object.assign(error, { recoveryDirectory: directory });
  }
  if (result.error) {
    // A timeout does not prove all descendants stopped. Preserve diagnostics.
    throw Object.assign(result.error, { recoveryDirectory: directory });
  }
  rmSync(directory, { recursive: true });
  return { ...result, stdout, stderr };
}
