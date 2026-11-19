import { readFile } from 'node:fs/promises';
import { admitRolloutManager } from './rollout-manager-context.mjs';
import { withManagerAdmission } from './rollout-manager-admission.mjs';
import { managerCredentialHost, hasManagedHost } from './managed-credential-host.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { advanceRolloutPool, observeInstalledManager } from './rollout-pool.mjs';
import { promoteHost } from './host-rollout.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { installSource } from './source-install.mjs';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { admitCoreMaintenance, coreMaintenanceProvenance }
  from './core-maintenance-identity.mjs';
import { privateCredentialPipe } from './managed-credential-input.mjs';
import { GitHubReader } from './github-read.mjs';

async function main(args) {
  await installedSharedRuntime();
  const context = await admitRolloutManager();
  const [operation, ...values] = args;
  if (operation === 'admit' && values.length === 0)
    return { status: 'admitted' };
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
    requireThat(Array.isArray(request) && request.every(value =>
      typeof value === 'string' && !value.includes('\0')) &&
      (request[0] === 'api' || request.slice(0, 2).join(' ') === 'pr merge'),
    'INVALID_ROLLOUT_PROVIDER_REQUEST');
    return withManagerAdmission(context, async () => {
      const host = await hasManagedHost() ? await managerCredentialHost(context) :
        JSON.parse(await readFile('/etc/nibfin/host.json', 'utf8'));
      const token = (await readPrivate(host.tokenFile, host, 16384)).trim();
      const result = await command('/usr/bin/gh', request,
        { env: { PATH: '/usr/bin:/bin', LANG: 'C', GH_PROMPT_DISABLED: '1',
          GH_TOKEN: token } });
      return { status: 'observed', bytes: result.stdout.toString('base64') };
    });
  }
  requireThat(false, 'INVALID_ROLLOUT_MANAGER_OPERATION');
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'pending') process.exitCode = 2;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]*$/.test(error.code ?? '') ? error.code :
    'CORE_ROLLOUT_OBSERVATION_UNAVAILABLE';
  process.stdout.write(JSON.stringify({ status: 'pending', code }) + '\n');
  process.exitCode = 2;
}
