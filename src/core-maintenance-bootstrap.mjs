import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { machine } from 'node:os';
import { spawn } from 'node:child_process';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { managerRoot, readManagerPin } from './rollout-manager-context.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { withCoreManagementGate } from './core-management-gate.mjs';
import { installVerifiedRolloutManager, publishManagerMetadata }
  from './core-manager-installation.mjs';
import { installedSharedRuntime, platformContract, sharedTargetFromContract,
  verifySharedFile } from './shared-platform.mjs';
import { requireThat } from './identity.mjs';
import contract from './core-maintenance-installation.json' with { type: 'json' };
import { inspectAdoptedSource } from './adopted-source-path.mjs';
import { readRolloutProcessResult } from './core-rollout-result.mjs';

const capabilityPath = 'src/core-maintenance-installation.json';

async function packageRuntime(root) {
  const capability = JSON.parse(await readFile(join(root, capabilityPath),
    'utf8'));
  requireThat(capability.schemaVersion === contract.schemaVersion &&
    capability.kind === contract.kind, 'CORE_MAINTENANCE_CAPABILITY_UNSUPPORTED');
  const version = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  const platform = platformContract(JSON.parse(await readFile(join(root,
    'src/shared-platform.json'), 'utf8')), version);
  const arch = Object.entries(platform.targets).find(([, value]) =>
    value.observations.includes(machine()))?.[0];
  const runtime = sharedTargetFromContract(platform, arch);
  await verifySharedFile(runtime.nodePath, runtime.nodeSha256, runtime);
  return runtime;
}

async function currentManager() {
  const pin = await readManagerPin();
  await verifyOwnedSourcePackage(managerRoot, pin);
  return { pin, runtime: await packageRuntime(managerRoot) };
}

export async function installManagerEntries(runtime, handle) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(runtime.nodePath,
      [join(managerRoot, 'src/core-maintenance-install-entry.mjs')], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'inherit', handle.fd], shell: false,
      });
    const chunks = [];
    child.stdout.on('data', bytes => chunks.push(bytes));
    child.once('error', reject);
    child.once('close', code => {
      resolve(readRolloutProcessResult(Buffer.concat(chunks).toString(), '', code));
    });
  });
  return result;
}

// Only the normal administrator's fixed verified archive installation can
// invoke this source. No request chooses code, a directory or a privileged mode.
export async function bootstrapCoreMaintenance() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === contract.bootstrapRoot, 'CORE_MAINTENANCE_FIXED_BOOTSTRAP_REQUIRED');
  const runtime = await installedSharedRuntime();
  return withCoreManagementGate(async handle => {
    await rootOwnedPath(contract.bootstrapPin);
    const pin = JSON.parse(await readFile(contract.bootstrapPin, 'utf8'));
    await verifyOwnedSourcePackage(coreRoot, pin);
    const hostPath = '/etc/nibfin/host.json';
    await rootOwnedPath(hostPath);
    const host = JSON.parse(await readFile(hostPath, 'utf8'));
    requireThat(host.installation?.directory === '/opt/nibfin/core' &&
      host.sharedRunner?.runner, 'CORE_MAINTENANCE_ADOPTED_POOL_REQUIRED');
    const adopted = await inspectAdoptedSource(host.installation.pin);
    const hasCapability = await readFile(join(adopted.path, capabilityPath), 'utf8')
      .then(() => true).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
    if (hasCapability) {
      // The host's adopted source wins over an older CLI bootstrap package.
      // Its complete verified bytes also repair interrupted metadata publication.
      const selected = await packageRuntime(adopted.path);
      await installVerifiedRolloutManager(adopted.path, host.installation.pin, selected);
      return installManagerEntries(selected, handle);
    }
    let existing;
    try { existing = await currentManager(); }
    catch (error) {
      if (!['ENOENT', 'SOURCE_MANIFEST_MISMATCH', 'ROLLOUT_MANAGER_METADATA_UNAVAILABLE']
        .includes(error.code)) throw error;
    }
    if (existing) {
      await publishManagerMetadata(existing.pin, existing.runtime);
      return installManagerEntries(existing.runtime, handle);
    }
    // Missing metadata after publication may be repaired from this independently
    // verified source. The shared installer reads the actual complete tree first.
    await installVerifiedRolloutManager(coreRoot, pin, runtime);
    return installManagerEntries(runtime, handle);
  });
}
