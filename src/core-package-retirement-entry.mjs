import { coreRoot } from './host-adoption.mjs';
import { requireThat } from './identity.mjs';
import { retireInstalledCorePackages } from './core-package-retirement-host.mjs';
import { writeCommandResult } from './command-result.mjs';
import { rolloutFailure } from './core-rollout-result.mjs';

// Internal verified installed entry. No caller-selected paths, modes or facts.
try {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core' && process.argv.length === 2,
  'CONTINUATION_REQUIRES_INSTALLED_ADMINISTRATOR');
  writeCommandResult({ status: 'complete',
    cleanup: await retireInstalledCorePackages() });
} catch (error) { writeCommandResult(rolloutFailure(error)); }
