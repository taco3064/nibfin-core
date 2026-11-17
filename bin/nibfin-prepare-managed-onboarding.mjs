#!/usr/bin/env node
import { prepareManagedOnboarding } from '../src/managed-onboarding.mjs';
import { requireThat } from '../src/identity.mjs';

try {
  requireThat(process.argv.length === 3 && process.argv[2] === '--consent-dedicated-engine',
    'MANAGED_ONBOARDING_CONSENT_REQUIRED');
  const result = await prepareManagedOnboarding();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'pending') process.exitCode = 2;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code ?? '')
    ? error.code : 'MANAGED_ONBOARDING_FAILED';
  process.stdout.write(JSON.stringify({ status: 'denied', code }) + '\n');
  process.exitCode = 1;
}
