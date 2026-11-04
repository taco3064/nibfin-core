#!/usr/bin/env node
import { consumerContract } from '../src/public-api.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { packageSource, verifyInstalledSource } from '../src/source-package.mjs';
import { installSource } from '../src/source-install.mjs';
import { requireThat } from '../src/identity.mjs';
import { launchStage } from '../src/host-launcher.mjs';
import { runWakeEntry } from '../src/wake-entry.mjs';
import { runIssueWake } from '../src/issue-wake.mjs';

// This entry point never imports a caller-selected adapter or runs candidate code.
async function main(args) {
  const [command, ...values] = args;
  if (command === 'dispatch-event' && values.length === 0) return runIssueWake();
  if (command === 'resolve-wake' && values.length === 0) return runWakeEntry();
  if (command === 'stage' && values.length === 2) return launchStage(values[0], values[1]);
  if (command === 'contract' && values.length === 0) return consumerContract;
  if (command === 'help' && values.length === 0) {
    return { commands: ['contract', 'pack <repository> <commit> <new-output-directory>',
      'verify <installation> <approved-pin.json>', 'install <archive> <new-directory> <approved-pin.json>',
      'stage <adopted-issue-number> <stage|continue>', 'resolve-wake', 'dispatch-event'],
    lifecycle: 'Stage execution requires administrator-adopted host configuration and live native admission.' };
  }
  if (command === 'pack' && values.length === 3) {
    const [root, commit, output] = values, built = await packageSource(resolve(root), commit);
    await mkdir(resolve(output), { mode: 0o700 });
    const pin = { repository: built.manifest.repository, commit, manifestHash: built.manifestHash, archiveHash: built.sha256 };
    await writeFile(join(output, 'nibfin-core.tar.gz'), built.bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'source-pin.json'), JSON.stringify(pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'packaged', ...pin };
  }
  if (command === 'verify' && values.length === 2) {
    const pin = JSON.parse(await readFile(values[1], 'utf8'));
    return { status: 'verified', source: await verifyInstalledSource(values[0], pin) };
  }
  if (command === 'install' && values.length === 3) {
    const pin = JSON.parse(await readFile(values[2], 'utf8'));
    return { status: 'installed', source: await installSource(await readFile(values[0]), values[1], pin) };
  }
  requireThat(false, 'INVALID_COMMAND');
}
main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'denied') process.exitCode = 1;
  if (result.status === 'pending') process.exitCode = 2;
}).catch(error => {
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'COMMAND_FAILED';
  process.stderr.write(JSON.stringify({ status: 'denied', code }) + '\n'); process.exitCode = 1;
});
