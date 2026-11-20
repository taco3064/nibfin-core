import { readFile } from 'node:fs/promises';
import { admitRolloutManager } from './rollout-manager-context.mjs';
import { withManagerAdmission } from './rollout-manager-admission.mjs';
import { managerCredentialHost, hasManagedHost } from './managed-credential-host.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { advanceRolloutPool, observeInstalledManager } from './rollout-pool.mjs';
import { promoteHost } from './host-rollout.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { installSource } from './source-install.mjs';
import { requireThat } from './identity.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { admitCoreMaintenance, coreMaintenanceProvenance }
  from './core-maintenance-identity.mjs';
import { privateCredentialPipe } from './managed-credential-input.mjs';
import { GitHubReader } from './github-read.mjs';
import { rolloutFailure, projectRolloutResult } from './core-rollout-result.mjs';
import { writeCommandResult } from './command-result.mjs';
import { coreRolloutProvider } from './core-rollout-provider.mjs';
import { assertRetirementCgroups, observeRetirementUnit } from './retirement-observe.mjs';

async function main(args) {
  await installedSharedRuntime();
  const context = await admitRolloutManager();
  const [operation, ...values] = args;
  if (operation === 'admit' && values.length === 0)
    return { status: 'admitted' };
  if (operation === 'admit-offline' && values.length === 0) {
    await observeRetirementUnit(1);
    await observeRetirementUnit(2);
    await assertRetirementCgroups();
    return { status: 'admitted' };
  }
  if (operation === 'authorize-core-only' && values.length === 0) {
    privateCredentialPipe();
    const parts = [];
    for await (const part of process.stdin) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString());
    const uid = process.env.SUDO_UID;
    requireThat(/^[1-9][0-9]*$/.test(uid ?? ''),
      'CORE_MAINTENANCE_INVOKER_CHANGED');
    // This borrowed credential lease ends before Python begins any operation.
    return withManagerAdmission(context, async () => {
      const host = await managerCredentialHost(context);
      const reader = new GitHubReader(
        (await readPrivate(host.tokenFile, host, 16384)).trim());
      const scope = await admitCoreMaintenance(context, host, request, Number(uid),
        reader);
      return { status: 'authorized',
        provenance: coreMaintenanceProvenance(scope, context) };
    });
  }
  if (operation === 'pool' && values.length === 1)
    return withManagerAdmission(context, scope =>
      advanceRolloutPool(values[0], context, scope));
  if (operation === 'promote-host' && values.length === 0)
    return promoteHost(context);
  if (operation === 'observe-installed' && values.length === 0)
    return withManagerAdmission(context, scope =>
      observeInstalledManager(context, scope));
  if (operation === 'verify' && values.length === 2) {
    const pin = JSON.parse(await readFile(values[1], 'utf8'));
    return { status: 'verified', source: await verifyInstalledSource(values[0], pin) };
  }
  if (operation === 'install' && values.length === 3) {
    const pin = JSON.parse(await readFile(values[2], 'utf8'));
    return { status: 'installed',
      source: await installSource(await readFile(values[0]), values[1], pin) };
  }
  if (operation === 'github' && values.length === 0) {
    const parts = [];
    for await (const part of process.stdin) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString());
    return withManagerAdmission(context, async () => {
      const host = await hasManagedHost() ? await managerCredentialHost(context) :
        JSON.parse(await readFile('/etc/nibfin/host.json', 'utf8'));
      const token = (await readPrivate(host.tokenFile, host, 16384)).trim();
      return coreRolloutProvider(request, token);
    });
  }
  requireThat(false, 'INVALID_ROLLOUT_MANAGER_OPERATION');
}

try {
  const result = await main(process.argv.slice(2));
  writeCommandResult(projectRolloutResult(result));
} catch (error) {
  writeCommandResult(rolloutFailure(error));
}
