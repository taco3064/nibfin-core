// Trusted Claude image entrypoint, copied into a read-only input mount by Core.
// Self-contained: it imports only Node built-ins and never candidate modules.
// Values marked "copy" are pinned equal to Core's by test/claude-bootstrap.test.mjs.
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// Copy of codexIdle and the used codexPreflightExits values, so every Core
// classifier keeps reading the existing codes for this provider.
export const claudeIdle = Object.freeze({ code: 'CODEX_IDLE_TIMEOUT', exitCode: 75 });
export const claudePreflightExits = Object.freeze({
  CODEX_UNAVAILABLE: 76,
  CODEX_VERSION_MISMATCH: 77,
  PROBE_PROXY_UNREACHABLE: 79,
  SANDBOX_PROBE_FAILED: 80,
  SUBSCRIPTION_LOGIN_UNAVAILABLE: 81,
});
// Copy of the Codex bootstrap's idle and startup timeouts and output bound.
export const claudeTimeouts = Object.freeze({ role: 10 * 60_000, startup: 60_000 });
export const outputLimit = 8 * 1024 * 1024;
// Copy: claudeLimits.stdin for the prompt plus one credential line (<= 1024 bytes).
export const inputLimit = 1024 * 1024 + 1024;
// Copy of claudeCredentialKinds patterns, each mapped to its own variable.
export const credentialVariables = Object.freeze([
  [/^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/, 'CLAUDE_CODE_OAUTH_TOKEN'],
  [/^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,500}$/, 'ANTHROPIC_API_KEY'],
]);
const executables = Object.freeze({ claude: '/opt/nibfin/claude/bin/claude',
  bwrap: '/usr/bin/bwrap', node: '/usr/local/bin/node' });
// Refreshed by the outer nibfin-bash invocation while a tool command runs.
export const progressMarker = '.nibfin-tool-progress';
const progressEvents = new Set(['system', 'assistant', 'user', 'result', 'tool']);
const progressItems = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use',
  'tool_result', 'running']);
const idleProgressPrefix = 'NIBFIN_IDLE_PROGRESS';

export function claudeIdleDiagnostic(stderr) {
  for (const line of String(stderr).split('\n')) {
    const [prefix, event, item, extra] = line.trimEnd().split(' ');
    if (prefix !== idleProgressPrefix || extra !== undefined) continue;
    if (event === 'none' && item === 'none') return line.trimEnd();
    if (progressEvents.has(event) && (item === 'none' || progressItems.has(item)))
      return line.trimEnd();
  }
  return undefined;
}

export function credentialVariable(value) {
  return credentialVariables.find(([pattern]) => pattern.test(value))?.[1];
}

export function runClaude(args, {
  input,
  environment = process.env,
  executable = executables.claude,
  cwd = '/work',
  idleTimeout = input === undefined ? claudeTimeouts.startup : claudeTimeouts.role,
  progressDirectory,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', size = 0, pending = '', stopped = false, watcher;
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      watcher?.close();
      child.kill('SIGKILL');
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      reject(new Error(code));
    };
    let lastProgress = 'none none';
    const timer = setTimeout(() => {
      if (input !== undefined)
        process.stderr.write(`${idleProgressPrefix} ${lastProgress}\n`);
      stop(claudeIdle.code);
    }, idleTimeout);
    const progress = (event, item) => {
      lastProgress = `${event} ${progressItems.has(item) ? item : 'none'}`;
      timer.refresh();
    };
    if (progressDirectory !== undefined) {
      try {
        watcher = watch(progressDirectory, (_type, name) => {
          if (name === progressMarker && !stopped) progress('tool', 'running');
        });
        watcher.on('error', () => {});
      } catch { /* Without the marker only stream events extend the deadline. */ }
    }
    const recordProgress = (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (progressEvents.has(event?.type) && event.type !== 'tool')
            progress(event.type, event.message?.content?.at?.(-1)?.type);
        } catch {
          // Non-event output does not extend the deadline.
        }
      }
    };
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('error', () => stop('CLAUDE_EXECUTION_FAILED'));
      stream.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > outputLimit) return stop('CLAUDE_OUTPUT_LIMIT');
        if (output) {
          stdout += chunk;
          if (input !== undefined) recordProgress(chunk);
        } else stderr += chunk;
      });
    }
    child.on('error', () => stop('CODEX_UNAVAILABLE'));
    child.on('close', (code) => {
      if (stopped) return;
      clearTimeout(timer);
      watcher?.close();
      if (code === 0 && size <= outputLimit) resolve({ stdout, stderr });
      else reject(new Error('CLAUDE_EXECUTION_FAILED'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Copy of parseClaudeResult's envelope checks; the role result schema itself is
// validated by Core. Returns the exact terminal line for Core to parse again.
export function terminalResult(stdout) {
  const lines = String(stdout).split('\n').filter(line => line.trim());
  const types = lines.map(line => {
    try { return JSON.parse(line)?.type; } catch { return undefined; }
  });
  const last = lines.at(-1);
  const invalid = () => { throw new Error('CLAUDE_RESULT_INVALID'); };
  if (types.filter(type => type === 'result').length !== 1 || types.at(-1) !== 'result')
    invalid();
  const envelope = JSON.parse(last);
  rejectDuplicateKeys(last, invalid);
  if (!envelope || Array.isArray(envelope) || envelope.is_error !== false ||
    envelope.subtype !== 'success' || !(envelope.errors === undefined ||
      Array.isArray(envelope.errors) && envelope.errors.length === 0)) invalid();
  if (typeof envelope.session_id !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(envelope.session_id))
    invalid();
  if (!envelope.structured_output || typeof envelope.structured_output !== 'object')
    invalid();
  return last;
}

// Copy of claude-result.mjs: JSON.parse silently accepts duplicate members.
function rejectDuplicateKeys(text, invalid) {
  const stack = [];
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{' || value === '[') {
      stack.push(value === '{' ? new Set() : null);
    } else if (value === '}' || value === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(token.index + value.length))) {
      const key = JSON.parse(value), keys = stack.at(-1);
      if (!keys || keys.has(key)) invalid();
      keys.add(key);
    }
  }
}

// The AppArmor profile must deny every environ read, including a sibling's,
// the parent's and the reader's own, before any credential enters a process.
export const environProbe = `
const fs = require('node:fs');
const paths = ['/proc/self/environ', '/proc/thread-self/environ'];
for (const task of fs.readdirSync('/proc/self/task'))
  paths.push('/proc/self/task/' + task + '/environ');
for (const pid of process.argv.slice(1))
  paths.push('/proc/' + pid + '/environ', '/proc/' + pid + '/task/' + pid + '/environ');
for (const path of paths) {
  try {
    fs.closeSync(fs.openSync(path, 'r'));
    fs.writeSync(2, 'NIBFIN_PROBE_READABLE ' + path + '\\n');
    process.exit(41);
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) {
      fs.writeSync(2, 'NIBFIN_PROBE_UNEXPECTED ' + path + ' ' + error.code + '\\n');
      process.exit(42);
    }
  }
}
fs.writeSync(1, 'NIBFIN_ENVIRON_DENIED\\n');
`;

// Same semantics as the Codex denial probe: a selected project Python must run
// under the project tool PATH and report exactly the selected version.
export const projectPythonCheck = `
const checkProjectPython = () => {
  if (!process.argv[3]) return;
  const { spawnSync } = require('node:child_process');
  const python = spawnSync('python3', ['--version'], {
    env: { PATH: process.argv[4], LANG: 'C.UTF-8' }, encoding: 'utf8',
  });
  if (python.status !== 0 || python.stdout.trim() !== 'Python ' + process.argv[3]) {
    require('node:fs').writeSync(2, 'NIBFIN_PROJECT_PYTHON_UNAVAILABLE\\n');
    process.exit(44);
  }
};
`;

// Runs inside bubblewrap with the sandbox mechanism Claude uses in Docker.
export const sandboxProbe = projectPythonCheck + `
const fs = require('node:fs');
const net = require('node:net');
const fail = (code, reason) => {
  fs.writeSync(2, 'NIBFIN_PROBE_VISIBLE ' + reason + '\\n');
  process.exit(code);
};
if (fs.readdirSync('/agent-home').length) fail(41, '/agent-home');
try {
  fs.closeSync(fs.openSync('/io/probe-sentinel', 'r'));
  fail(41, '/io/probe-sentinel');
} catch (error) {
  if (error.code !== 'ENOENT') fail(42, '/io/probe-sentinel ' + error.code);
}
const passed = () => {
  checkProjectPython();
  fs.writeSync(1, 'NIBFIN_SANDBOX_DENIED\\n');
  process.exit(0);
};
const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
socket.once('connect', () => fail(43, 'proxy'));
socket.once('error', passed);
setTimeout(() => { socket.destroy(); passed(); }, 1500);
`;

export function sandboxProbeArguments(proxyHost, proxyPort, node = executables.node,
  python = null, toolPath = '') {
  return ['--unshare-user', '--unshare-net', '--die-with-parent',
    '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--tmpfs', '/agent-home', '--tmpfs', '/io',
    '--', node, '-e', sandboxProbe, proxyHost, String(proxyPort),
    ...(python ? [python, toolPath] : [])];
}

export async function denialProbe(proxyHost, {
  proxyPort = 3128, node = executables.node, bwrap = executables.bwrap,
  python = null, toolPath = '',
} = {}) {
  const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const sibling = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...environment, NIBFIN_PROBE_SENTINEL: randomBytes(16).toString('hex') },
    stdio: 'ignore',
  });
  sibling.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      sibling.once('spawn', resolve);
      sibling.once('error', reject);
    });
    const environ = await runClaude(['-e', environProbe, String(sibling.pid),
      String(process.pid)], { executable: node, environment, cwd: '/' });
    if (environ.stdout !== 'NIBFIN_ENVIRON_DENIED\n') throw new Error('ENVIRON');
    const sandbox = await runClaude(
      sandboxProbeArguments(proxyHost, proxyPort, node, python, toolPath),
      { executable: bwrap, environment, cwd: '/' });
    if (sandbox.stdout !== 'NIBFIN_SANDBOX_DENIED\n') throw new Error('SANDBOX');
  } catch (error) {
    throw new Error('SANDBOX_PROBE_FAILED', { cause: error });
  } finally {
    sibling.kill('SIGKILL');
  }
}

// Line one is the credential, the rest is the prompt. Neither touches a file.
export async function readInput(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    chunks.push(chunk);
    if (size > inputLimit) break;
  }
  const bytes = Buffer.concat(chunks);
  try {
    const text = bytes.toString('utf8'), end = text.indexOf('\n');
    const token = text.slice(0, end), variable = credentialVariable(token);
    if (size > inputLimit || end < 0 || !variable)
      throw new Error('SUBSCRIPTION_LOGIN_UNAVAILABLE');
    return { variable, token, prompt: text.slice(end + 1) };
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

// Written only after Claude exited: never follow or reuse an existing entry.
export async function writeOutput(path, text) {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
}

function proxyReachable(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = () => {
      socket.destroy();
      reject(new Error('PROBE_PROXY_UNREACHABLE'));
    };
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', fail);
    socket.setTimeout(5000, fail);
  });
}

// `root` and the executables relocate fixed image paths for fixture tests only.
export async function bootstrap({ root = '', input = process.stdin, proxyPort = 3128,
  claude = executables.claude, bwrap = executables.bwrap, node = executables.node,
} = {}) {
  const invocation = JSON.parse(await readFile(`${root}/input/invocation.json`, 'utf8'));
  const { plan, codexVersion, proxyHost, jobVm } = invocation;
  const cwd = root + plan.cwd;
  const version = await runClaude(['--version'], { executable: claude, cwd });
  if (version.stdout.trim() !== codexVersion) throw new Error('CODEX_VERSION_MISMATCH');
  // This entry implements the Docker writer mode only.
  if (jobVm) throw new Error('SANDBOX_PROBE_FAILED');
  for (const directory of plan.toolDirectories)
    await mkdir(root + directory, { recursive: true, mode: 0o700 });
  const home = `${root}/agent-home`, sentinel = `${root}/io/probe-sentinel`;
  await writeFile(`${home}/${progressMarker}`, '', { mode: 0o600 });
  await writeFile(sentinel, 'Private Core output must not be visible to tools',
    { mode: 0o600 });
  // Confirm controller access before requiring the tool sandbox to deny it.
  for (const path of [`${home}/${progressMarker}`, sentinel]) await readFile(path);
  await proxyReachable(proxyHost, proxyPort);
  await denialProbe(proxyHost, { proxyPort, node, bwrap,
    python: plan.projectPython, toolPath: plan.toolEnvironment?.PATH });
  const { variable, token, prompt } = await readInput(input);
  const result = await runClaude(plan.args, {
    input: prompt, executable: claude, cwd, progressDirectory: home,
    environment: { ...process.env, [variable]: token },
  });
  const stdout = terminalResult(result.stdout);
  // Core scans these private streams before any result enters an evidence receipt.
  await writeOutput(`${root}/io/probe.json`, JSON.stringify({
    policyHash: plan.policyHash, stdout: 'NIBFIN_PROBE_PASSED\n', codexVersion,
  }));
  await writeOutput(`${root}/io/stream.json`,
    JSON.stringify({ stdout, stderr: result.stderr }));
}

export function entryExit(error) {
  const idle = error?.message === claudeIdle.code;
  const preflightExit = Object.hasOwn(claudePreflightExits, error?.message)
    ? claudePreflightExits[error.message] : undefined;
  const diagnostic = preflightExit ? error.message : 'NIBFIN_AGENT_ENTRY_FAILED';
  return { exitCode: idle ? claudeIdle.exitCode : preflightExit ?? 1,
    stderr: idle ? 'NIBFIN_AGENT_IDLE_TIMEOUT\n' : `${diagnostic}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().catch((error) => {
    const { exitCode, stderr } = entryExit(error);
    process.stderr.write(stderr);
    process.exitCode = exitCode;
  });
}
