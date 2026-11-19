import { admitInstalledSharedWorker } from './shared-worker-local.mjs';
import { sharedWorkerDiagnostic } from './shared-worker-reader.mjs';

try { await admitInstalledSharedWorker(); }
catch (error) {
  process.stderr.write(`Nibfin pre-Worker admission: ${sharedWorkerDiagnostic(error)}\n`);
  process.exitCode = 1;
}
