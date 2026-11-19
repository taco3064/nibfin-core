#!/usr/bin/env node
import { completeInstalledLifecycle } from '../src/installed-lifecycle.mjs';
import { retireInstalledNotificationRelay }
  from '../src/notification-retirement-host.mjs';
import { readDiagnosisInput } from '../src/diagnosis-input.mjs';
import { retireSharedHost } from '../src/retirement-host.mjs';
import { activateSharedReplacement } from '../src/retirement-activate.mjs';
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
import { recoverDeliverFence } from '../src/recover-deliver-fence.mjs';
import { recoverCommitPr, recoverReview } from '../src/recover-commit-pr.mjs';
import { promoteHost } from '../src/host-rollout.mjs';
import { inspectSharedHost } from '../src/shared-host-inspect.mjs';
import { installSharedServiceTemplate } from '../src/shared-service-install.mjs';
import { installAndStartSharedServices } from '../src/shared-service-start.mjs';
import { adoptSharedPeer, refreshManagedIssueCaller }
  from '../src/shared-peer-adoption.mjs';
import { adoptSharedHost } from '../src/shared-host-adopt.mjs';

import { readLocalWorkInput } from '../src/local-work-input.mjs';

import { credentialAdministrator } from '../src/managed-credentials.mjs';

// This entry point never imports a caller-selected adapter or runs candidate code.
async function main(args) {
  const [command, ...values] = args;
  if (command === 'request-local-diagnosis' && values.length === 0)
    return readDiagnosisInput(process.stdin);
  if (command === 'observe-local-work' && values.length === 0)
    return readLocalWorkInput(process.stdin);
  if (command === 'managed-credentials' && values.length === 1)
    return credentialAdministrator(values[0]);
  if (command === 'resolve-event' && values.length === 0) return runIssueWake();
  if (command === 'dispatch-event' && values.length === 1)
    return launchIssueWake(values[0]);
  if (command === 'resolve-wake' && values.length === 0) return runWakeEntry();
  if (command === 'stage' && values.length === 2)
    return launchStage(values[0], values[1]);
  if (command === 'recover-deliver-fence' && values.length === 1)
    return recoverDeliverFence(values[0]);
  if (command === 'recover-commit-pr' && values.length === 2)
    return recoverCommitPr(values[0], values[1]);
  if (command === 'recover-review' && values.length === 2)
    return recoverReview(values[0], values[1]);
  if (command === 'retire-shared-host' && values.length === 0)
    return retireSharedHost();
  if (command === 'activate-shared-replacement' && values.length === 0)
    return activateSharedReplacement();
  if (command === 'complete-installed-lifecycle' && values.length === 0)
    return completeInstalledLifecycle();
  if (command === 'retire-notification-relay' && values.length === 0)
    return retireInstalledNotificationRelay();
  if (command === 'promote-host' && values.length === 0) return promoteHost();
  if (command === 'contract' && values.length === 0) return consumerContract;
  if (command === 'inspect-shared-host' && values.length === 0)
    return inspectSharedHost();
  if (command === 'install-shared-service-template' && [0, 3].includes(values.length))
    return installSharedServiceTemplate(values.slice(1), Number(values[0]));
  if (command === 'start-shared-services' && [0, 3].includes(values.length))
    return installAndStartSharedServices(values.slice(1), Number(values[0]));
  if (command === 'adopt-shared-peer' && values.length === 3)
    return adoptSharedPeer(values[0], Number(values[1]), values[2]);
  if (command === 'refresh-managed-issue-caller' && values.length === 2)
    return refreshManagedIssueCaller(values[0], Number(values[1]));
  if (command === 'adopt-shared-host' && values.length === 5) {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      requireThat(size <= 4096, 'INVALID_SHARED_HOST_SOURCE_PIN');
      chunks.push(chunk);
    }
    const pin = Buffer.concat(chunks).toString('utf8');
    return adoptSharedHost(values[0], Number(values[1]), Number(values[2]),
      values[3], values[4].split(',').map(Number), pin);
  }
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
        'complete-installed-lifecycle (installed administrator, no input or arguments)',
        'managed-credentials <intake|replace|status|disconnect> (local admin)',
        'inspect-shared-host',
        'observe-local-work (private JSON stdin, no arguments)',
        'request-local-diagnosis (private JSON stdin, no arguments)',
        'retire-shared-host (local administrator, no arguments)',
        'retire-notification-relay (local administrator, no arguments)',
        'activate-shared-replacement (local administrator, no arguments)',
        'install-shared-service-template',
        'start-shared-services',
        'adopt-shared-host (administrator-only, root-owned profile and source pin)',
        'adopt-shared-peer <repository> <repository-id> <action-commit>',
        'refresh-managed-issue-caller <repository> <repository-id> (administrator-only)',
        'pack <repository> <commit> <new-output-directory>',
        'verify <installation> <approved-pin.json>',
        'install <archive> <new-directory> <approved-pin.json>',
        'stage <adopted-issue-number> <stage|continue>',
        'recover-deliver-fence <adopted-issue-number> (local administrator)',
        'recover-commit-pr <adopted-issue-number> <observed-pr-head>',
        'recover-review <adopted-issue-number> <observed-pr-head>',
        'promote-host (administrator-only, root-owned rollout plan)',
        'resolve-wake',
        'resolve-event',
        'dispatch-event <adopted-issue-number>',
        'export-mcp <codex> <settings-home> <auth-home> <member-id> <new-private-file>',
        'import-mcp <member-id> <new-private-file> (private stdin only)',
      ],
      installedLifecycleCompletion: consumerContract.installedLifecycleCompletion,
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
    const pending = ['MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE',
      'MANAGED_CREDENTIAL_CONSUMER_PENDING'].includes(code);
    process.stderr.write(JSON.stringify({ status: pending ? 'pending' : 'denied',
      code }) + '\n');
    process.exitCode = pending ? 2 : 1;
  });
