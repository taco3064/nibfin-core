import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { runJobVmReadiness } from './job-vm-readiness.mjs';
import { writeCommandResult } from './command-result.mjs';
import { requireThat } from './identity.mjs';

// Any VM-behaviour module, including the Claude guest shell route, re-runs readiness.
export const executionFiles = new Set([
  'src/security/job-vm-init.sh', 'src/security/job-vm-executor.py',
  'src/job-vm.mjs', 'src/job-vm-tools.mjs', 'src/job-vm-payload.py',
  'src/job-vm-writer.mjs', 'src/job-vm-guest-workspace.mjs',
  'src/job-vm-workspace.mjs', 'src/job-vm-channel.mjs',
  'src/job-vm-exec-relay.mjs', 'src/project-tool-paths.mjs',
  'src/job-vm-shell.mjs', 'src/claude-vm-shell.mjs',
]);
const assetKeys = ['executable', 'kernel', 'rootDisk'];

// Changes unrelated to VM behavior do not need a VM boot. Use the verified
// package's existing manifest and current installed assets, never a release pin.
export async function jobVmEnvironment(host) {
  if (!host.jobVm) return { configured: false };
  const root = host.installation.directory;
  await verifyInstalledSource(root, host.installation.pin);
  const manifest = JSON.parse(await readFile(join(root, 'nibfin-manifest.json'), 'utf8'));
  const files = manifest.files.filter(file => executionFiles.has(file.path))
    .map(({ path, sha256, mode }) => ({ path, sha256, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const assets = await Promise.all(assetKeys.map(async key => {
    const path = host.jobVm[key];
    await rootOwnedPath(path);
    const value = await lstat(path, { bigint: true });
    requireThat(value.isFile(), 'JOB_VM_ASSET_NOT_FILE');
    return [path, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs]
      .map(String);
  }));
  return { configured: true, files, assets, memoryMiB: host.jobVm.memoryMiB };
}

export async function probeInstalledJobVm() {
  requireThat(process.platform === 'linux' && coreRoot === '/opt/nibfin/core' &&
    process.argv.length === 2, 'JOB_VM_READINESS_CONTROLLER_REQUIRED');
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  requireThat(process.getuid() === host.uid && host.jobVm &&
    host.installation.directory === coreRoot, 'JOB_VM_READINESS_CONTROLLER_REQUIRED');
  await verifyInstalledSource(coreRoot, host.installation.pin);
  await privateHostDirectory(host.stateRoot);
  const executor = await readFile(join(coreRoot, 'src/security/job-vm-executor.py'));
  return runJobVmReadiness({ ...host.jobVm, stateRoot: host.stateRoot,
    pressureRoot: host.stateRoot }, executor);
}

// A separate fixed process runs under the adopted Controller, not Runner/root.
if (process.argv[1] === '/opt/nibfin/core/src/job-vm-readiness-host.mjs') {
  try { writeCommandResult(await probeInstalledJobVm()); }
  catch (error) {
    writeCommandResult({ status: 'pending',
      code: /^JOB_VM_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code :
        'JOB_VM_READINESS_UNAVAILABLE' });
  }
}
