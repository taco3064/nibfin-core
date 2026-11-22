#!/usr/bin/env node
import {
  prepareManagedSharedHost, preparationAgent,
} from '../src/managed-resource-install.mjs';
import { requireThat } from '../src/identity.mjs';
import { lstat } from 'node:fs/promises';
import { resourcePreparationGate } from '../src/managed-resource-admission.mjs';

try {
  const [consent, request, ...extra] = process.argv.slice(2);
  requireThat(consent === '--consent-resource-preparation' && extra.length === 0 &&
    (request === undefined || request.startsWith('--agent=')),
  'RESOURCE_PREPARATION_CONSENT_REQUIRED');
  const agent = preparationAgent(request?.slice('--agent='.length));
  const result = await prepareManagedSharedHost(true, { agent });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'pending') process.exitCode = 2;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '')
    ? error.code : 'RESOURCE_PREPARATION_FAILED';
  const guarded = await lstat(resourcePreparationGate).then(() => true,
    error => error.code !== 'ENOENT');
  const pending = guarded ||
    /RECONCILIATION_REQUIRED|UNKNOWN|PENDING|UNRESOLVED/.test(code);
  process.stdout.write(JSON.stringify({ status: pending ? 'pending' : 'denied',
    code, adoption: false, servicesReady: false }) + '\n');
  process.exitCode = pending ? 2 : 1;
}
