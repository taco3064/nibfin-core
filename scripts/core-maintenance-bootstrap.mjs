import { bootstrapCoreMaintenance } from '../src/core-maintenance-bootstrap.mjs';
import { writeCommandResult } from '../src/command-result.mjs';
import { rolloutFailure } from '../src/core-rollout-result.mjs';

try {
  const result = process.argv.length === 2 ? await bootstrapCoreMaintenance() :
    { status: 'denied', code: 'CORE_MAINTENANCE_BOOTSTRAP_HAS_NO_ARGUMENTS' };
  writeCommandResult(result);
} catch (error) {
  writeCommandResult(rolloutFailure(error));
}
