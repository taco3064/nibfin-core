import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { boundedHostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { withRelayGate, writeRelayState } from './relay-state.mjs';
import {
  loadRelayHost, relayStateRoot, relayUnitDirectory, relayUnits,
} from './relay-host.mjs';
import { NotificationRelay, safeRelayCode } from './notification-relay.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';

export async function writeRelayResource(directory, name, content, inspect) {
  const target = join(directory, name);
  const confirm = async () => {
    await inspect(target);
    requireThat((await lstat(target)).isFile() &&
      await boundedHostFile(target, 16384) === content, 'RELAY_RESOURCE_CONFLICT');
  };
  const present = await lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (present) { await confirm(); return 'unchanged'; }
  const temp = join(directory, `.relay-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o644);
  try {
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    try { await link(temp, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await unlink(temp);
    await syncRecoveryDirectory(directory);
    await confirm();
    return 'prepared';
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function unitContents() {
  const { nodePath } = await installedSharedRuntime();
  const result = new Map();
  for (const name of relayUnits) {
    const path = join(coreRoot, 'src/security', name);
    await rootOwnedPath(path);
    const template = await boundedHostFile(path, 16384);
    result.set(name, template.replaceAll('NODE_RUNTIME', nodePath));
  }
  return result;
}

async function serviceState() {
  try {
    await rootOwnedPath('/usr/bin/systemctl');
    const { stdout } = await command('/usr/bin/systemctl', [
      'show', ...relayUnits, '--property=Id,LoadState,ActiveState,UnitFileState',
    ], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 4096 });
    const units = stdout.toString().trim().split('\n\n').map(block =>
      Object.fromEntries(block.split('\n').map(line => line.split('='))));
    requireThat(units.length === 2 && units.every(unit => relayUnits.includes(unit.Id) &&
      ['loaded', 'not-found'].includes(unit.LoadState) &&
      ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(
        unit.ActiveState)), 'RELAY_SERVICE_STATE_UNKNOWN');
    return { status: 'observed', units };
  } catch { return { status: 'unknown' }; }
}

export async function prepareNotificationRelay() {
  const context = await loadRelayHost();
  const contents = await unitContents();
  await rootOwnedPath(relayUnitDirectory);
  await rootOwnedPath('/var/lib');
  await mkdir('/var/lib/nibfin', { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath('/var/lib/nibfin');
  let created = false;
  try { await mkdir(relayStateRoot, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await context.journal.prepare();
  const initialized = await withRelayGate(relayStateRoot, async () => {
    if (created) await writeRelayState(relayStateRoot, 'control.json', {
      schemaVersion: 1, paused: true,
    });
    await context.journal.control();
    return { status: 'prepared' };
  });
  if (initialized.status === 'pending') return initialized;
  const resources = [];
  await context.inspect();
  for (const [name, content] of contents) resources.push({ name,
    status: await writeRelayResource(relayUnitDirectory, name, content, rootOwnedPath) });
  return { status: 'prepared', resources, servicesStarted: false,
    github: { status: 'verified', ...context.verified },
    control: await context.journal.control(), service: await serviceState() };
}

export async function inspectNotificationRelay() {
  const local = await loadRelayHost({ authenticate: false });
  const contents = await unitContents();
  const resources = [];
  for (const [name, content] of contents) {
    let status = 'missing';
    try {
      await rootOwnedPath(join(relayUnitDirectory, name));
      status = await boundedHostFile(join(relayUnitDirectory, name), 16384) === content
        ? 'prepared' : 'conflicting';
    } catch (error) { if (error.code !== 'ENOENT') status = 'untrusted'; }
    resources.push({ name, status });
  }
  let recovery;
  try {
    const records = await local.journal.records();
    recovery = { status: 'observed', control: await local.journal.control(),
      records: records.map(record => ({ origin: record.origin, status: record.status,
        code: record.code, runId: record.runId, issue: record.intent?.issue,
        destination: record.intent?.destination })) };
  } catch (error) { recovery = { status: 'unknown', code: safeRelayCode(error) }; }
  let github;
  try {
    const current = await loadRelayHost();
    github = { status: 'verified', ...current.verified };
  } catch (error) { github = { status: 'unverified', code: safeRelayCode(error) }; }
  return { status: 'inspected', resources, github, recovery,
    service: await serviceState() };
}

export async function controlNotificationRelay(paused) {
  const context = await loadRelayHost({ authenticate: false });
  return context.journal.setPaused(paused);
}

export async function pollNotificationRelay() {
  const context = await loadRelayHost({ verifyRemote: false });
  await context.journal.control();
  return new NotificationRelay(context).poll();
}
