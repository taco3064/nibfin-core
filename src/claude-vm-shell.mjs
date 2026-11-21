// Claude VM-mode tool shell client, copied read-only to /input/vm-shell.mjs by
// Core and run by nibfin-bash with an empty environment. Self-contained: Node
// built-ins only. It forwards one Bash tool script to the Core guest shell and
// never sends the container environment, which holds Claude's credential.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

export const shellWork = '/work';
// Guest frames are untrusted: bound them like the guest bounds command output.
export const shellOutputLimit = 8 * 1024 * 1024;
const frameLimit = 256 * 1024;
// Claude ends each tool script with `pwd -P >| /tmp/claude-<hex>-cwd`.
const cwdFilePattern = /pwd -P >\| '?(\/tmp\/claude-[0-9a-f]{1,64}-cwd)'?\s*$/;

export function shellCwdFile(script) {
  return cwdFilePattern.exec(script)?.[1];
}

const insideWork = path => path === shellWork || path.startsWith(shellWork + '/');

// Normalized absolute paths only: `/work/../etc` must not pass as inside /work.
function validPath(path) {
  return typeof path === 'string' && path.startsWith('/') && path.length <= 4096 &&
    !/[\0\n]/.test(path) && normalize(path) === path &&
    (path === '/' || !path.endsWith('/'));
}

// The nearest ancestor that exists in the local read-only /work copy.
export function nearestLocal(path, isDirectory = localDirectory) {
  let current = path;
  while (current !== shellWork && !isDirectory(current)) current = dirname(current);
  return current;
}

function localDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

// Keep the previous guest cwd only when Claude's spawn cwd still matches it;
// otherwise Claude moved or reset its cwd and the command starts there.
export function startDirectory(previous, spawn, isDirectory = localDirectory) {
  const start = insideWork(spawn) ? spawn : shellWork;
  return validPath(previous) && insideWork(previous) &&
    nearestLocal(previous, isDirectory) === start ? previous : start;
}

// Claude's own policy resets a cwd outside /work to /work.
export function reportedDirectory(final, isDirectory = localDirectory) {
  return validPath(final) && insideWork(final) ? nearestLocal(final, isDirectory) :
    shellWork;
}

export function readToolEnvironment(path) {
  const unavailable = () => {
    const code = 'NIBFIN_TOOL_ENVIRONMENT_UNAVAILABLE';
    throw Object.assign(new Error(code), { code });
  };
  let entries;
  try { entries = readFileSync(path, 'utf8').split('\0'); } catch { unavailable(); }
  if (entries.pop() !== '') unavailable();
  return Object.fromEntries(entries.map(entry => {
    const end = entry.indexOf('=');
    if (end < 1) unavailable();
    return [entry.slice(0, end), entry.slice(end + 1)];
  }));
}

// One request, then stdout/stderr/cwd frames and a final exit or error frame.
export function shellExchange(socket, request, { stdout, stderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    let pending = '', output = 0, cwd, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(Object.assign(new Error(error), { code: error }));
      else resolve(value);
    };
    const abort = () => finish('JOB_VM_SHELL_TIMEOUT');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    const frame = line => {
      let value;
      try { value = JSON.parse(line); } catch { return finish('JOB_VM_SHELL_INVALID'); }
      if (['stdout', 'stderr'].includes(value?.type) &&
        typeof value.data === 'string') {
        const bytes = Buffer.from(value.data, 'base64');
        output += bytes.length;
        if (output > shellOutputLimit) return finish('JOB_VM_SHELL_OUTPUT_LIMIT');
        (value.type === 'stdout' ? stdout : stderr)?.(bytes);
      } else if (value?.type === 'cwd' && validPath(value.path) && cwd === undefined) {
        cwd = value.path;
      } else if (value?.type === 'exit' && Number.isInteger(value.code) &&
        value.code >= 0 && value.code <= 255) {
        finish(undefined, { code: value.code, cwd });
      } else if (value?.type === 'error' &&
        /^JOB_VM_SHELL_[A-Z_]{1,64}$/.test(value.code)) {
        finish(value.code);
      } else finish('JOB_VM_SHELL_INVALID');
    };
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      if (pending.length > frameLimit) return finish('JOB_VM_SHELL_INVALID');
      for (const line of lines) if (!settled) frame(line);
    });
    socket.once('error', () => finish('JOB_VM_SHELL_UNAVAILABLE'));
    socket.once('close', () => finish('JOB_VM_SHELL_DISCONNECTED'));
    // Never half-close: the guest treats end of input as a disconnect.
    socket.write(JSON.stringify(request) + '\n');
  });
}

export async function runShell(script, { socketPath, environmentPath, statePath,
  spawn = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  connect = createConnection } = {}) {
  let previous;
  try { previous = readFileSync(statePath, 'utf8'); } catch { previous = undefined; }
  const cwdFile = shellCwdFile(script);
  const request = { operation: 'run', script, cwd: startDirectory(previous, spawn),
    env: readToolEnvironment(environmentPath), ...(cwdFile ? { cwdFile } : {}) };
  const result = await shellExchange(connect(socketPath), request, {
    stdout: bytes => stdout.write(bytes), stderr: bytes => stderr.write(bytes),
  });
  if (cwdFile && result.cwd !== undefined) {
    writeFileSync(statePath, result.cwd, { mode: 0o600 });
    writeFileSync(cwdFile, reportedDirectory(result.cwd));
  }
  return result.code;
}

// argv: <socket> <tool-environment> <guest-cwd state> <script>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [socketPath, environmentPath, statePath, script] = process.argv.slice(2);
  runShell(script, { socketPath, environmentPath, statePath }).then(code => {
    process.exitCode = code;
  }, error => {
    process.stderr.write(`${/^[A-Z_]{1,80}$/.test(error.code ?? '') ? error.code :
      'JOB_VM_SHELL_UNAVAILABLE'}\n`);
    process.exitCode = 126;
  });
}
