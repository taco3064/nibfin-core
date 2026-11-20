import { withReplacementAwareAdoptionLock } from './retirement-lock.mjs';
import { requireNoRetirement } from './retirement-admission.mjs';
import { pendingReplacement } from './retirement-rebind.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { sharedHostRegistrations } from './shared-host-inspect.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { checkSharedRunnerSlot } from './security/shared-runner-start-check.mjs';
import { installSharedSlot } from './shared-slot-install.mjs';
import { sharedSlotIsolation } from './shared-runner.mjs';
import { installedSharedRuntime, selectSharedPlatform, elfMachine }
  from './shared-platform.mjs';
import { engineHost } from './engine-host.mjs';
import { engine } from './engine-contract.mjs';
import { machine } from 'node:os';

const templatePath = 'src/security/nibfin-shared-runner.service.template';
const wslPath = 'src/security/runner-wsl-host.conf';
const unitName = 'nibfin-shared-runner@.service';
export const unitDirectory = '/etc/systemd/system';

export async function readSharedServiceUnit(directory, inspect) {
  const target = join(directory, unitName);
  await inspect(target);
  requireThat((await lstat(target)).isFile(), 'SHARED_SERVICE_TEMPLATE_CONFLICT');
  return boundedHostFile(target, 16384);
}

export async function writeSharedServiceTemplate(directory, content, inspect, previous) {
  const target = join(directory, unitName);
  const temp = join(directory, `.nibfin-unit-${randomUUID()}`);
  const read = () => readSharedServiceUnit(directory, inspect);
  const confirm = async () => requireThat(await read() === content,
    'SHARED_SERVICE_TEMPLATE_CONFLICT');
  const existing = await lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    const actual = await read();
    if (actual === content) return 'unchanged';
    requireThat(actual === previous, 'SHARED_SERVICE_TEMPLATE_CONFLICT');
  } else requireThat(previous === undefined, 'SHARED_SERVICE_TEMPLATE_CONFLICT');
  const file = await open(temp, 'wx', 0o644);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    if (existing) {
      requireThat(await read() === previous, 'SHARED_SERVICE_TEMPLATE_CONFLICT');
      await rename(temp, target);
      await syncRecoveryDirectory(directory);
      await confirm();
      return 'updated';
    }
    try { await link(temp, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await unlink(temp);
      await confirm();
      return 'unchanged';
    }
    await unlink(temp);
    await syncRecoveryDirectory(directory);
    await confirm();
    return 'installed';
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function installSharedServiceTemplate(sources = [], owner) {
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'SHARED_SERVICE_REQUIRES_HOST_ADMINISTRATOR');
  requireThat(coreRoot === '/opt/nibfin/core', 'SHARED_SERVICE_REQUIRES_INSTALLED_CORE');
  return withManagedAdmission(() => withReplacementAwareAdoptionLock(async () => {
    await requireSharedServicePreparation();
    return installLockedSharedTemplate(sources, owner);
  }));
}

export async function requireSharedServicePreparation() {
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 256 * 1024));
  if (!await pendingReplacement(host)) await requireNoRetirement();
}

export async function installLockedSharedTemplate(sources = [], owner) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'SHARED_SERVICE_REQUIRES_INSTALLED_CORE');
  await Promise.all([hostFile, unitDirectory].map(rootOwnedPath));
  const hostBytes = await boundedHostFile(hostFile, 256 * 1024);
  const host = JSON.parse(hostBytes);
  const { repository, runners } = sharedHostRegistrations(host);
  await verifyInstalledSource(coreRoot, host.installation.pin);
  const unit = await readSharedServiceSource(coreRoot);
  requireThat(sources.length === 0 || sources.length === 2 && sources[0] !== sources[1],
    'INVALID_SHARED_SLOT_INPUT');
  const target = await installedSharedRuntime();
  await rootOwnedPath(engine.daemon);
  const daemonExecutable = elfMachine(await readFile(engine.daemon));
  const info = JSON.parse(await engineHost().docker(true,
    ['info', '--format', '{{json .}}']));
  const engineTarget = selectSharedPlatform({ platform: info.OSType, kernel: machine(),
    runtime: process.arch, executable: daemonExecutable, daemon: info.Architecture });
  requireThat(engineTarget.arch === target.arch, 'SHARED_PLATFORM_MISMATCH');
  const uids = [host.runnerUid, host.sharedRunner.additionalRunner.uid];
  const second = sharedSlotIsolation(host, uids[1]);
  requireThat(second !== host.repository.isolation,
    'SHARED_RUNNER_SECOND_SLOT_ISOLATION_REQUIRED');
  for (const [index, runner] of runners.entries()) {
    if (sources.length) await installSharedSlot(sources[index], index + 1,
      owner, runner, repository, uids[index]);
    const directory = `/var/lib/nibfin/runners/slot-${index + 1}`;
    await checkSharedRunnerSlot(directory, runner, repository, { checkAccess: false });
  }
  requireThat(await boundedHostFile(hostFile, 256 * 1024) === hostBytes &&
    await readSharedServiceSource(coreRoot) === unit,
    'HOST_ADOPTION_CHANGED');
  const status = await writeSharedServiceTemplate(unitDirectory, unit, rootOwnedPath);
  return { status, unit: unitName, servicesStarted: false };
}

export async function readSharedServiceSource(source) {
  const read = async path => {
    await rootOwnedPath(path);
    return boundedHostFile(path, 16384);
  };
  const wsl = /microsoft.*wsl2/i.test(
    await readFile('/proc/sys/kernel/osrelease', 'utf8'));
  return sharedServiceTemplate(await read(join(source, templatePath)),
    wsl ? await read(join(source, wslPath)) : '');
}

export function sharedServiceTemplate(template, restrictions) {
  if (!restrictions) return template;
  const install = '\n\n[Install]\n';
  requireThat(template.includes(install) && restrictions.startsWith('[Service]\n'),
    'INVALID_SHARED_SERVICE_TEMPLATE');
  return template.replace(install,
    '\n' + restrictions.slice('[Service]\n'.length).trimEnd() + install);
}
