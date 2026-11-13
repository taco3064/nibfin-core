// Trusted image entrypoint, copied into a read-only input mount by Core.
// Never import candidate modules or evaluate candidate strings as commands.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const codexIdle = Object.freeze({ code: 'CODEX_IDLE_TIMEOUT', exitCode: 75 });
export const codexPreflightExits = Object.freeze({
  CODEX_UNAVAILABLE: 76,
  CODEX_VERSION_MISMATCH: 77,
  MANAGED_PROFILE_UNSUPPORTED: 78,
  PROBE_PROXY_UNREACHABLE: 79,
  SANDBOX_PROBE_FAILED: 80,
  SUBSCRIPTION_LOGIN_UNAVAILABLE: 81,
});
const roleIdleTimeout = 10 * 60_000;
const startupTimeout = 60_000;
const progressEvents = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed',
]);
const progressItems = new Set([
  'agent_message', 'reasoning', 'command_execution', 'file_change',
  'mcp_tool_call', 'web_search', 'todo_list', 'error',
]);
const idleProgressPrefix = 'NIBFIN_IDLE_PROGRESS';

export function idleDiagnostic(stderr) {
  for (const line of String(stderr).split('\n')) {
    const [prefix, event, item, extra] = line.trimEnd().split(' ');
    if (prefix !== idleProgressPrefix || extra !== undefined) continue;
    if (event === 'none' && item === 'none') return line.trimEnd();
    if (progressEvents.has(event) && (item === 'none' || progressItems.has(item)))
      return line.trimEnd();
  }
  return undefined;
}

export const denialProbe = `
const fs = require('node:fs');
const paths = ['/auth/auth.json', '/agent-home/auth.json',
  '/auth/mcp.toml', '/agent-home/config.toml',
  '/agent-home/.credentials.json', '/io/probe-sentinel', '/proc/1/environ'];
const parent = '/proc/' + process.argv[2];
paths.push(parent + '/environ', parent + '/mem', parent + '/fd/0',
  parent + '/root/auth/auth.json', parent + '/root/agent-home/auth.json',
  parent + '/root/io/probe-sentinel');
for (const path of paths) {
  try {
    fs.closeSync(fs.openSync(path, 'r'));
    fs.writeSync(2, 'NIBFIN_PROBE_READABLE ' + path + '\\n');
    process.exit(41);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) {
      fs.writeSync(2, 'NIBFIN_PROBE_UNEXPECTED ' + path + ' ' + error.code + '\\n');
      process.exit(42);
    }
  }
}
const net = require('node:net');
const socket = net.connect({host: process.argv[1], port: 3128});
socket.once('connect', () => process.exit(43));
const passed = () => {
  fs.writeSync(1, 'NIBFIN_PROBE_PASSED\\n');
  process.exit(0);
};
socket.once('error', passed);
setTimeout(() => { socket.destroy(); passed(); }, 1500);
`;

// Both bootstrap and real CLI diagnostics use these exact argument recipes.
export function sandboxProbeArguments(plan, proxyHost, controllerPid) {
  return [
    ...plan.settings, 'sandbox', '--permissions-profile', 'nibfin',
    '--include-managed-config', '--cd', '/tmp/tool-home', '--',
    '/usr/local/bin/node', '-e', denialProbe, proxyHost,
    ...(controllerPid === undefined ? [] : [String(controllerPid)]),
  ];
}

export function subscriptionStatusArguments(plan) {
  return [...plan.settings, 'login', 'status'];
}

export function runCodex(args, {
  input,
  environment = process.env,
  executable = '/usr/local/bin/codex',
  cwd = '/session',
  idleTimeout = input === undefined ? startupTimeout : roleIdleTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env: environment, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', size = 0, pending = '', stopped = false;
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      reject(new Error(code));
    };
    let lastProgress = 'none none';
    const timer = setTimeout(() => {
      if (input !== undefined)
        process.stderr.write(`${idleProgressPrefix} ${lastProgress}\n`);
      stop(codexIdle.code);
    }, idleTimeout);
    const recordProgress = (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (progressEvents.has(event?.type)) {
            const item = progressItems.has(event.item?.type) ? event.item.type : 'none';
            lastProgress = `${event.type} ${item}`;
            timer.refresh();
          }
        } catch {
          // Non-event output does not extend the deadline.
        }
      }
    };
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('error', () => stop('CODEX_EXECUTION_FAILED'));
      stream.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) return stop('CODEX_OUTPUT_LIMIT');
        if (output) {
          stdout += chunk;
          if (input !== undefined) recordProgress(chunk);
        } else stderr += chunk;
      });
    }
    child.on('error', () => stop('CODEX_UNAVAILABLE'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= 8 * 1024 * 1024) resolve({ stdout, stderr });
      else reject(new Error('CODEX_EXECUTION_FAILED'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function jobVmArguments(args) {
  const relay = `
const net = require('node:net');
const socket = net.createConnection('/job-vm.sock');
socket.once('error', error => {
  process.stderr.write(error.code + '\\n');
  process.exit(1);
});
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`;
  await writeFile('/agent-home/environments.toml', [
    'default = "job"', 'include_local = false', '[[environments]]', 'id = "job"',
    'program = "/usr/local/bin/node"', 'args = ' + JSON.stringify(['-e', relay]),
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  const filesystem = 'permissions.nibfin.filesystem=';
  return args.filter(arg => arg !== '--ignore-user-config').map(arg => {
    if (!arg.startsWith(filesystem)) return arg;
    return arg.replace(/}$/, ', "/run/docker.sock" = "write" }');
  }).flatMap(arg => arg === 'exec' ? [
    '-c',
    'permissions.nibfin.network.unix_sockets={ "/run/docker.sock" = "allow" }',
    '-c', 'shell_environment_policy.set.DOCKER_HOST="unix:///run/docker.sock"',
    arg,
  ] : [arg]);
}

export async function bootstrap() {
  const invocation = JSON.parse(await readFile('/input/invocation.json', 'utf8'));
  const { plan, codexVersion, proxyHost, jobVm } = invocation;
  const version = await runCodex(['--version']);
  if (version.stdout.trim() !== codexVersion) throw new Error('CODEX_VERSION_MISMATCH');
  // A newly mounted requirements file must not be ignored by an older CLI.
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(codexVersion);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 138)
    throw new Error('MANAGED_PROFILE_UNSUPPORTED');
  await mkdir('/tmp/tool-home', { recursive: true, mode: 0o700 });
  await copyFile('/auth/auth.json', '/agent-home/auth.json');
  if (plan.mcpPolicyHash) {
    await copyFile('/auth/mcp.toml', '/agent-home/config.toml');
  }
  await writeFile('/io/probe-sentinel',
    'Private Core output must not be visible to tools', { mode: 0o600 });
  // Confirm controller access before requiring the tool sandbox to deny it.
  const privatePaths = ['/auth/auth.json', '/agent-home/auth.json', '/io/probe-sentinel'];
  for (const path of privatePaths) await readFile(path);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: 3128 });
    const fail = () => {
      socket.destroy();
      reject(new Error('PROBE_PROXY_UNREACHABLE'));
    };
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', fail);
    socket.setTimeout(5000, fail);
  });
  const probe = await runCodex(sandboxProbeArguments(plan, proxyHost, process.pid), {
    environment: { ...process.env, HOME: '/tmp/tool-home' },
  }).catch(error => {
    throw new Error('SANDBOX_PROBE_FAILED', { cause: error });
  });
  if (probe.stdout !== 'NIBFIN_PROBE_PASSED\n')
    throw new Error('SANDBOX_PROBE_FAILED');
  await writeFile('/io/probe.json', JSON.stringify({
    policyHash: plan.policyHash, stdout: probe.stdout, codexVersion,
  }), { mode: 0o600 });
  const login = await runCodex(subscriptionStatusArguments(plan)).catch(error => {
    throw new Error('SUBSCRIPTION_LOGIN_UNAVAILABLE', { cause: error });
  });
  if (!/logged in using chatgpt/i.test(login.stdout + login.stderr))
    throw new Error('SUBSCRIPTION_LOGIN_UNAVAILABLE');
  const result = await runCodex(
    jobVm ? await jobVmArguments(plan.args) : plan.args, { input: plan.prompt });
  // Core scans these private streams before any result enters an evidence receipt.
  await writeFile('/io/stream.json', JSON.stringify(result), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().catch((error) => {
    const idle = error.message === codexIdle.code;
    const preflightExit = Object.hasOwn(codexPreflightExits, error.message)
      ? codexPreflightExits[error.message] : undefined;
    const diagnostic = preflightExit ? error.message : 'NIBFIN_AGENT_ENTRY_FAILED';
    process.stderr.write(idle ? 'NIBFIN_AGENT_IDLE_TIMEOUT\n' : `${diagnostic}\n`);
    process.exitCode = idle ? codexIdle.exitCode : preflightExit ?? 1;
  });
}
