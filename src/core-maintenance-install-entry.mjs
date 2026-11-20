import { admitRolloutManager } from './rollout-manager-context.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { installCoreMaintenanceEntries } from './core-maintenance-install.mjs';
import { writeCommandResult } from './command-result.mjs';
import { rolloutFailure } from './core-rollout-result.mjs';

try {
  await installedSharedRuntime();
  const context = await admitRolloutManager();
  const result = await installCoreMaintenanceEntries(context);
  writeCommandResult(result);
} catch (error) {
  writeCommandResult(rolloutFailure(error));
}
