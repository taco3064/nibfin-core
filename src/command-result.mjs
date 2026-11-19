// Shared result publication for the fixed Core administrator entry. It grants
// no command, source or credential selection to its caller.
export function writeCommandResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'denied') process.exitCode = 1;
  if (result.status === 'pending') process.exitCode = 2;
}
