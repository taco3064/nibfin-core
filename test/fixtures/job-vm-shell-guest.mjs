import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openJobVmExecRelay } from '../../src/job-vm-exec-relay.mjs';
import { jobVmShellPort } from '../../src/job-vm-shell.mjs';

const repository = new URL('../..', import.meta.url).pathname;

// Simulated guest: the maintained executor shell handler on a Unix socket,
// reached through the maintained host relay like a Claude container would.
export async function startShellGuest(t, root) {
  const work = join(root, 'guest-work'), log = join(root, 'guest-requests.log');
  const guest = join(root, 'guest-shell.sock'), relay = join(root, 'shell.sock');
  await mkdir(work);
  const child = spawn('python3', ['-B', 'test/fixtures/job-vm-shell-guest.py', guest,
    work, join(root, 'guest-cgroup'), log], { cwd: repository,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
  t.after(() => child.kill('SIGKILL'));
  const [line] = await once(createInterface({ input: child.stdout }), 'line');
  if (line !== 'ready') throw new Error('Shell guest fixture did not start');
  const ports = [];
  const close = await openJobVmExecRelay(relay, async (port, signal) => {
    ports.push(port);
    return createConnection({ path: guest, signal });
  }, jobVmShellPort);
  t.after(close);
  return { work, relay, ports, requests: async () => (await readFile(log, 'utf8'))
    .trim().split('\n').map(entry => JSON.parse(entry)) };
}
