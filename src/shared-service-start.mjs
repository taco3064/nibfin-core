import { withManagedAdmission } from './managed-credential-admission.mjs';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { installSharedServiceTemplate } from './shared-service-install.mjs';

const systemctl = '/usr/bin/systemctl';
const fragment = '/etc/systemd/system/nibfin-shared-runner@.service';
const units = [1, 2].map(slot => `nibfin-shared-runner@${slot}.service`);
const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 8192 };
const properties = [
  'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
  'ActiveState', 'SubState', 'MainPID', 'User', 'Group',
];

async function readUnit(run, unit, index) {
  const { stdout } = await run(systemctl, [
    'show', ...properties.flatMap(name => ['--property', name]), unit,
  ], options);
  const values = new Map(stdout.toString().trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const account = `nibfin-runner-${index + 1}`;
  requireThat(values.get('LoadState') === 'loaded' &&
    values.get('FragmentPath') === fragment && values.get('DropInPaths') === '' &&
    values.get('NeedDaemonReload') === 'no' && values.get('User') === account &&
    values.get('Group') === account, 'SHARED_SERVICE_EFFECTIVE_UNIT_CONFLICT');
  return values;
}

const running = unit => unit.get('ActiveState') === 'active' &&
  unit.get('SubState') === 'running' && /^[1-9]\d*$/.test(unit.get('MainPID'));

export async function startSharedServices(run = command) {
  const observe = () =>
    Promise.all(units.map((unit, index) => readUnit(run, unit, index)));
  await run(systemctl, ['daemon-reload'], options);
  const initial = await observe();
  requireThat(initial.every(unit => running(unit) ||
    unit.get('ActiveState') === 'inactive' && unit.get('SubState') === 'dead'),
  'SHARED_SERVICE_SETTLEMENT_REQUIRED');
  const inactive = units.filter((_, index) => !running(initial[index]));
  if (inactive.length) {
    await run(systemctl, ['start', ...inactive], options).catch(() => {});
  }
  requireThat((await observe()).every(running), 'SHARED_SERVICE_START_READBACK_REQUIRED');
  return { servicesStarted: true, units };
}

export async function installAndStartSharedServices(sources, owner) {
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'SHARED_SERVICE_REQUIRES_HOST_ADMINISTRATOR');
  return withManagedAdmission(async () => {
    await rootOwnedPath(systemctl);
    const installation = await installSharedServiceTemplate(sources, owner);
    return { ...installation, ...await startSharedServices() };
  });
}
