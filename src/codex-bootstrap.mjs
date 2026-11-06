// Trusted image entrypoint, copied into a read-only input mount by Core.
// Never import candidate modules or evaluate candidate strings as commands.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const denialProbe = `
const fs = require('node:fs');
const paths = ['/auth/auth.json', '/agent-home/auth.json',
  '/auth/mcp.toml', '/agent-home/config.toml',
  '/agent-home/.credentials.json', '/io/probe-sentinel', '/proc/1/environ'];
for (const path of paths) {
  try {
    fs.readFileSync(path);
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
export function sandboxProbeArguments(plan, proxyHost) {
  return [
    ...plan.settings, 'sandbox', '--permissions-profile', 'nibfin',
    '--include-managed-config', '--cd', '/tmp/tool-home', '--',
    '/usr/local/bin/node', '-e', denialProbe, proxyHost,
  ];
}

export function subscriptionStatusArguments(plan) {
  return [...plan.settings, 'login', 'status'];
}

function run(args, { input, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/local/bin/codex', args, {
      cwd: '/session', env: environment, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', size = 0;
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', (bytes) => {
        size += bytes.length;
        if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
        else if (output) stdout += bytes;
        else stderr += bytes;
      });
    }
    child.on('error', () => reject(new Error('CODEX_UNAVAILABLE')));
    child.on('close', (code) => {
      if (code === 0 && size <= 8 * 1024 * 1024) resolve({ stdout, stderr });
      else reject(new Error('CODEX_EXECUTION_FAILED'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function bootstrap() {
  const invocation = JSON.parse(await readFile('/input/invocation.json', 'utf8'));
  const { plan, codexVersion, proxyHost } = invocation;
  const version = await run(['--version']);
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
  const probe = await run(sandboxProbeArguments(plan, proxyHost), {
    environment: { ...process.env, HOME: '/tmp/tool-home' },
  });
  if (probe.stdout !== 'NIBFIN_PROBE_PASSED\n')
    throw new Error('SANDBOX_PROBE_FAILED');
  await writeFile('/io/probe.json', JSON.stringify({
    policyHash: plan.policyHash, stdout: probe.stdout, codexVersion,
  }), { mode: 0o600 });
  const login = await run(subscriptionStatusArguments(plan));
  if (!/logged in using chatgpt/i.test(login.stdout + login.stderr))
    throw new Error('SUBSCRIPTION_LOGIN_UNAVAILABLE');
  const result = await run(plan.args, { input: plan.prompt });
  // Core scans these private streams before any result enters an evidence receipt.
  await writeFile('/io/stream.json', JSON.stringify(result), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().catch(() => {
    process.stderr.write('NIBFIN_AGENT_ENTRY_FAILED\n');
    process.exitCode = 1;
  });
}
