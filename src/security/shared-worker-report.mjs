import { admitInstalledSharedWorker } from './shared-worker-local.mjs';
import { rolloutFailure } from '../core-rollout-result.mjs';
import { writeCommandResult } from '../command-result.mjs';

try {
  await admitInstalledSharedWorker();
  writeCommandResult({ status: 'admitted' });
} catch (error) { writeCommandResult(rolloutFailure(error)); }
