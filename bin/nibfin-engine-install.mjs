#!/usr/bin/env node
import { installManagedEngine } from '../src/engine-install.mjs';
import { requireThat } from '../src/identity.mjs';

// Fixed installed administrator entry. No workflow dispatch, adapter, endpoint,
// executable, unit, profile or filesystem path is accepted from the caller.
async function main(args) {
  requireThat(args.length === 2 && args[0] === '--dedicated-disposable-host' &&
    args[1] === '--acknowledge-stock-handoff',
  'ENGINE_DEDICATED_HOST_ACKNOWLEDGEMENT_REQUIRED');
  return installManagedEngine(true);
}

main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'pending') process.exitCode = 2;
}).catch(error => {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '')
    ? error.code : 'ENGINE_INSTALLATION_FAILED';
  const pending = /RECONCILIATION_REQUIRED|UNKNOWN$/.test(code);
  process.stderr.write(JSON.stringify({ status: pending ? 'pending' : 'denied',
    code }) + '\n');
  process.exitCode = pending ? 2 : 1;
});
