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
import { launchIssueWake } from '../src/host-issue-wake.mjs';
import { exportUserMcp, importUserMcp } from '../src/mcp-transfer.mjs';
import { recoverCommitPr, recoverReview } from '../src/recover-commit-pr.mjs';
import { promoteHost } from '../src/host-rollout.mjs';

// This entry point never imports a caller-selected adapter or runs candidate code.
async function main(args) {
  const [command, ...values] = args;
  if (command === 'resolve-event' && values.length === 0) return runIssueWake();
  if (command === 'dispatch-event' && values.length === 1)
    return launchIssueWake(values[0]);
  if (command === 'resolve-wake' && values.length === 0) return runWakeEntry();
  if (command === 'stage' && values.length === 2)
    return launchStage(values[0], values[1]);
  if (command === 'recover-commit-pr' && values.length === 2)
    return recoverCommitPr(values[0], values[1]);
  if (command === 'recover-review' && values.length === 2)
    return recoverReview(values[0], values[1]);
  if (command === 'promote-host' && values.length === 0) return promoteHost();
  if (command === 'contract' && values.length === 0) return consumerContract;
  if (command === 'export-mcp' && values.length === 5) {
    const [codex, home, authenticationHome, member, output] = values;
    return exportUserMcp({ codex, home, authenticationHome,
      memberId: Number(member), output });
  }
  if (command === 'import-mcp' && values.length === 2)
    return importUserMcp(process.stdin, Number(values[0]), values[1]);
  if (command === 'help' && values.length === 0) {
    return {
      commands: [
        'contract',
        'pack <repository> <commit> <new-output-directory>',
        'verify <installation> <approved-pin.json>',
        'install <archive> <new-directory> <approved-pin.json>',
        'stage <adopted-issue-number> <stage|continue>',
        'recover-commit-pr <adopted-issue-number> <observed-pr-head>',
        'recover-review <adopted-issue-number> <observed-pr-head>',
        'promote-host (administrator-only, root-owned rollout plan)',
        'resolve-wake',
        'resolve-event',
        'dispatch-event <adopted-issue-number>',
        'export-mcp <codex> <settings-home> <auth-home> <member-id> <new-private-file>',
        'import-mcp <member-id> <new-private-file> (private stdin only)',
      ],
      lifecycle:
        'Stage execution requires administrator-adopted host configuration ' +
        'and live native admission.',
    };
  }
  if (command === 'pack' && values.length === 3) {
    const [root, commit, output] = values,
      built = await packageSource(resolve(root), commit);
    await mkdir(resolve(output), { mode: 0o700 });
    const pin = {
      repository: built.manifest.repository,
      commit,
      manifestHash: built.manifestHash,
      archiveHash: built.sha256,
    };
    await writeFile(join(output, 'nibfin-core.tar.gz'), built.bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(output, 'source-pin.json'),
      JSON.stringify(pin, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    return { status: 'packaged', ...pin };
  }
  if (command === 'verify' && values.length === 2) {
    const pin = JSON.parse(await readFile(values[1], 'utf8'));
    return { status: 'verified', source: await verifyInstalledSource(values[0], pin) };
  }
  if (command === 'install' && values.length === 3) {
    const pin = JSON.parse(await readFile(values[2], 'utf8'));
    return {
      status: 'installed',
      source: await installSource(await readFile(values[0]), values[1], pin),
    };
  }
  requireThat(false, 'INVALID_COMMAND');
}
main(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'denied') process.exitCode = 1;
    if (result.status === 'pending') process.exitCode = 2;
  })
  .catch((error) => {
    const code =
      typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'COMMAND_FAILED';
    process.stderr.write(JSON.stringify({ status: 'denied', code }) + '\n');
    process.exitCode = 1;
  });
