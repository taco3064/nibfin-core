// Live smoke: run only on an authorized disposable host with the installed Core
// and #329 Engine. This operation creates resources; it is not a simulation.
import { pathToFileURL } from 'node:url';
import { requireThat } from './identity.mjs';
import { prepareManagedSharedHost } from './managed-resource-install.mjs';
import { managedPreparationCapability } from './managed-resource-contract.mjs';

export function verifyPreparationResult(result) {
  requireThat(result.status === 'prepared' && result.adoption === false &&
    result.servicesReady === false && result.images &&
    ['agent', 'hooks'].every(kind =>
      /^sha256:[a-f0-9]{64}$/.test(result.images[kind])), 'RESOURCE_SMOKE_FAILED');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireThat(process.argv.length === 3 &&
      process.argv[2] === managedPreparationCapability.arguments[0],
    'RESOURCE_PREPARATION_CONSENT_REQUIRED');
    const first = verifyPreparationResult(await prepareManagedSharedHost(true));
    const second = verifyPreparationResult(await prepareManagedSharedHost(true));
    requireThat(JSON.stringify(first) === JSON.stringify(second),
      'RESOURCE_SMOKE_REPEAT_CHANGED');
    process.stdout.write(JSON.stringify(second) + '\n');
  } catch {
    process.stdout.write('{"status":"denied","code":"RESOURCE_SMOKE_FAILED"}\n');
    process.exitCode = 1;
  }
}
