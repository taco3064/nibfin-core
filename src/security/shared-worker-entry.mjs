import { join } from 'node:path';
import { boundedHostFile, hostFile } from '../host-adoption.mjs';
import { rootOwnedPath } from '../host-paths.mjs';
import { requireThat } from '../identity.mjs';
import { sharedRunner } from '../shared-runner.mjs';
import { admitSharedWorker } from './shared-worker-admission.mjs';
import { relaySharedWorker } from './shared-worker-relay.mjs';

const slots = ['/var/lib/nibfin/runners/slot-1', '/var/lib/nibfin/runners/slot-2'];

async function main() {
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  const target = { repositoryId: host.repository?.approval?.repositoryId };
  const { runner, caller } = sharedRunner(host, target, process.getuid());
  const slot = slots[process.getuid() === host.runnerUid ? 0 : 1];
  requireThat(process.cwd() === join(slot, 'bin'), 'SHARED_WORKER_SLOT_MISMATCH');
  const worker = join(slot, 'bin', 'Runner.Worker.official');
  await rootOwnedPath(worker);
  const reader = { get: async path => {
    const res = await fetch(`https://api.github.com${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    requireThat(res.ok, 'SHARED_WORKER_PROVIDER_UNAVAILABLE');
    return res.json();
  } };
  return relaySharedWorker(process.argv.slice(2), worker,
    message => admitSharedWorker(reader, message, runner, caller.ref, caller.ownerId));
}

try {
  process.exitCode = await main();
} catch {
  process.stderr.write('Nibfin did not admit the Runner job.\n');
  process.exitCode = 1;
}
