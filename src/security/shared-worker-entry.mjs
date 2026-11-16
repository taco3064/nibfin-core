import { join } from 'node:path';
import { boundedHostFile, hostFile } from '../host-adoption.mjs';
import { rootOwnedPath } from '../host-paths.mjs';
import { requireThat } from '../identity.mjs';
import { sharedRunner } from '../shared-runner.mjs';
import { admitSharedWorker } from './shared-worker-admission.mjs';
import { sharedWorkerDiagnostic, sharedWorkerReader } from './shared-worker-reader.mjs';

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
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireThat(size <= 50_000_000, 'SHARED_WORKER_FRAME_INVALID');
    chunks.push(chunk);
  }
  const input = new TextDecoder('utf-16le', { fatal: true });
  const message = JSON.parse(input.decode(Buffer.concat(chunks)));
  const credential = message?.variables?.['system.github.token'];
  await admitSharedWorker(sharedWorkerReader(credential), message, runner, caller.ref,
    caller.ownerId);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Nibfin pre-Worker admission: ${sharedWorkerDiagnostic(error)}\n`);
  process.exitCode = 1;
}
