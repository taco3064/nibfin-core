import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { coreOnlyRuntimeFacts } from './core-only-compatibility.mjs';
import { sharedServiceTemplate } from './shared-service-install.mjs';
import { serviceTemplate } from './retirement-observe.mjs';
import { ensureInstalledRunnerIdentity, inspectInstalledRunnerIdentity }
  from './installed-runner-state.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { platformContract, sharedTargetFromContract, verifySharedFile }
  from './shared-platform.mjs';
import { hostFile } from './host-adoption.mjs';
import { machine } from 'node:os';
import { requireThat } from './identity.mjs';

const dispatcher = 'src/security/shared-worker-dispatcher.sh';
const service = 'src/security/nibfin-shared-runner.service.template';

async function readOwned(path) {
  await rootOwnedPath(path);
  return readFile(path, 'utf8');
}

// The management Node belongs to its verified code closure. Pool runtime facts
// instead come from the actual adopted package, read only as verified data.
export async function currentPoolRuntime(context, read = readOwned) {
  const admitted = requireManagerContext(context);
  const host = JSON.parse(await read(hostFile));
  // installationPath performs full verification before returning live/backup.
  const directory = await admitted.installationPath(host.installation.pin);
  const version = (await read(join(directory, '.node-version'))).trim();
  const platform = platformContract(JSON.parse(await read(join(directory,
    'src/shared-platform.json'))), version);
  const arch = Object.entries(platform.targets).find(([, value]) =>
    value.observations.includes(machine()))?.[0];
  requireThat(arch, 'UNSUPPORTED_SHARED_PLATFORM');
  const target = sharedTargetFromContract(platform, arch);
  requireThat(target.observations.includes(process.arch), 'SHARED_PLATFORM_MISMATCH');
  await verifySharedFile(target.nodePath, target.nodeSha256, target);
  return { directory, target, bootstrapVersion: platform.runnerVersion };
}

export async function observeCoreOnlyRuntime(selected, target, {
  read = readOwned,
  kernel = () => readFile('/proc/sys/kernel/osrelease', 'utf8'),
} = {}) {
  const after = await coreOnlyRuntimeFacts(selected, target.arch, read);
  const restrictions = /microsoft.*wsl2/i.test(await kernel()) ?
    await read(join(selected, 'src/security/runner-wsl-host.conf')) : '';
  after.files[service] = sharedServiceTemplate(after.files[service], restrictions);
  after.files[dispatcher] = [after.files[dispatcher], after.files[dispatcher]];
  const scripts = [];
  for (const slot of [1, 2]) scripts.push(await read(
    `/var/lib/nibfin/runners/slot-${slot}/bin/Runner.Worker`));
  const before = { node: target.nodeVersion, artifactArch: target.artifactArch,
    elfMachine: target.elfMachine, nodeSha256: target.nodeSha256,
    observations: target.observations,
    files: { [dispatcher]: scripts, [service]: await read(serviceTemplate) } };
  return { before, after };
}

// This reuses the existing trusted bootstrap migration producer. It changes
// only installer metadata, never Runner executables, settings or registration.
export async function prepareCoreOnlyRunnerIdentity(binding, runtime, {
  inspectOnly = false,
} = {}) {
  const { target, bootstrapVersion } = runtime;
  for (const slot of binding.slots) {
    const local = await verifySharedSlotIdentity(slot.path, slot.runner,
      binding.pool.repository);
    const operation = inspectOnly ? inspectInstalledRunnerIdentity :
      ensureInstalledRunnerIdentity;
    await operation(slot.path, local, target, { bootstrapVersion });
  }
}
