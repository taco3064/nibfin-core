#!/usr/bin/env node
import { buildRelease } from '../src/release-build.mjs';
import { requireThat } from '../src/identity.mjs';

async function main(args) {
  requireThat(args.length === 3, 'INVALID_COMMAND');
  return buildRelease(...args);
}

main(process.argv.slice(2)).then((result) => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch((error) => {
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
    ? error.code : 'COMMAND_FAILED';
  process.stderr.write(JSON.stringify({ status: 'denied', code }) + '\n');
  process.exitCode = 1;
});
