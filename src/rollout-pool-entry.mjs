import { advanceRolloutPool } from './rollout-pool.mjs';
import { writeRetirementFile, readRetirementFile } from './retirement-files.mjs';
import { rolloutPlanPath } from './rollout-admission.mjs';

// Fixed host administrator interface used by the installed timer, never a
// workflow adapter. No path, token, service or settlement assertions are accepted.
try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Invalid rollout operation');
  const result = await advanceRolloutPool(args[0]);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'pending') process.exitCode = 2;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '')
    ? error.code : 'ROLLOUT_OBSERVATION_UNKNOWN';
  if (process.getuid() === 0) {
    const plan = await readRetirementFile(rolloutPlanPath);
    if (plan) await writeRetirementFile(rolloutPlanPath, { ...plan, pending: code });
  }
  process.stderr.write(JSON.stringify({ status: 'pending', code }) + '\n');
  process.exitCode = 2;
}
