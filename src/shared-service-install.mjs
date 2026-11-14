import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { sharedHostRegistrations } from './shared-host-inspect.mjs';
import { verifyInstalledSource } from './source-package.mjs';

const templatePath = 'src/security/nibfin-shared-runner.service.template';
const wslPath = 'src/security/runner-wsl-host.conf';
const unitName = 'nibfin-shared-runner@.service';
const unitDirectory = '/etc/systemd/system';

export async function writeSharedServiceTemplate(directory, content, inspect) {
  const target = join(directory, unitName);
  const temp = join(directory, `.nibfin-unit-${randomUUID()}`);
  const confirm = async () => {
    await inspect(target);
    requireThat((await lstat(target)).isFile(), 'SHARED_SERVICE_TEMPLATE_CONFLICT');
    requireThat(await boundedHostFile(target, 16384) === content,
      'SHARED_SERVICE_TEMPLATE_CONFLICT');
  };
  const existing = await lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    await confirm();
    return 'unchanged';
  }
  const file = await open(temp, 'wx', 0o644);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
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

export async function installSharedServiceTemplate() {
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'SHARED_SERVICE_REQUIRES_HOST_ADMINISTRATOR');
  requireThat(coreRoot === '/opt/nibfin/core', 'SHARED_SERVICE_REQUIRES_INSTALLED_CORE');
  const template = join(coreRoot, templatePath);
  await Promise.all([hostFile, template, unitDirectory].map(rootOwnedPath));
  const hostBytes = await boundedHostFile(hostFile, 256 * 1024);
  const host = JSON.parse(hostBytes);
  sharedHostRegistrations(host);
  const wsl = /microsoft.*wsl2/i.test(
    await readFile('/proc/sys/kernel/osrelease', 'utf8'));
  const profile = join(coreRoot, wslPath);
  if (wsl) await rootOwnedPath(profile);
  const content = await boundedHostFile(template, 16384);
  const restrictions = wsl ? await boundedHostFile(profile, 16384) : '';
  await verifyInstalledSource(coreRoot, host.installation.pin);
  requireThat(await boundedHostFile(hostFile, 256 * 1024) === hostBytes &&
    await boundedHostFile(template, 16384) === content &&
    (!wsl || await boundedHostFile(profile, 16384) === restrictions),
    'HOST_ADOPTION_CHANGED');
  const unit = sharedServiceTemplate(content, restrictions);
  const status = await writeSharedServiceTemplate(unitDirectory, unit, rootOwnedPath);
  return { status, unit: unitName, servicesStarted: false };
}

export function sharedServiceTemplate(template, restrictions) {
  if (!restrictions) return template;
  const install = '\n\n[Install]\n';
  requireThat(template.includes(install) && restrictions.startsWith('[Service]\n'),
    'INVALID_SHARED_SERVICE_TEMPLATE');
  return template.replace(install,
    '\n' + restrictions.slice('[Service]\n'.length).trimEnd() + install);
}
