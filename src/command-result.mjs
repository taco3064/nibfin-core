import contract from './core-rollout-result.json' with { type: 'json' };

// Shared result publication for the fixed Core administrator entry. It grants
// no command, source or credential selection to its caller.
export function writeCommandResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (Object.hasOwn(contract.failureExitCodes, result.status))
    process.exitCode = contract.failureExitCodes[result.status];
}
