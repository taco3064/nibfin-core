import { join } from 'node:path';
import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { relayUnits, relayUnitDirectory } from './relay-host.mjs';
import { requireThat } from './identity.mjs';
import { assertEmptyUnitCgroups } from './retirement-observe.mjs';

const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 16384 };

export class NotificationCleanupServices {
  constructor(run = command, inspect = rootOwnedPath,
    cgroups = () => assertEmptyUnitCgroups(relayUnits)) {
    Object.assign(this, { run, inspect, cgroups });
  }
  async observe() {
    await this.inspect('/usr/bin/systemctl');
    const units = [];
    for (const name of relayUnits) {
      const { stdout } = await this.run('/usr/bin/systemctl', ['show', name,
        '--property=Id,LoadState,FragmentPath,DropInPaths,NeedDaemonReload',
        '--property=ActiveState,SubState,MainPID,ControlGroup,User,Group,UnitFileState',
      ], options);
      const unit = Object.fromEntries(stdout.toString().trim().split('\n').map(line => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      requireThat(unit.Id === name && ['loaded', 'not-found'].includes(unit.LoadState) &&
        unit.DropInPaths === '' && (unit.LoadState === 'not-found' ||
          unit.FragmentPath === join(relayUnitDirectory, name)) &&
        (name.endsWith('.timer') || unit.LoadState === 'not-found' ||
          unit.User === 'root' && unit.Group === 'root'),
      'NOTIFICATION_SERVICE_CONFLICT');
      units.push(unit);
    }
    return units;
  }
  async stopAndDisable() {
    // Timer first: it must not start the service after its termination check.
    for (const name of [...relayUnits].reverse()) {
      let unit = (await this.observe()).find(item => item.Id === name);
      if (unit.ActiveState !== 'inactive')
        await this.run('/usr/bin/systemctl', ['stop', name], options);
      unit = (await this.observe()).find(item => item.Id === name);
      if (!['disabled', 'static', '', 'not-found'].includes(unit.UnitFileState))
        await this.run('/usr/bin/systemctl', ['disable', name], options);
    }
  }
  async requireStopped() {
    for (const unit of await this.observe())
      requireThat(unit.ActiveState === 'inactive' &&
        (unit.MainPID === '0' || unit.MainPID === '') && unit.ControlGroup === '' &&
        ['disabled', 'static', '', 'not-found'].includes(unit.UnitFileState),
      'NOTIFICATION_SERVICE_PENDING');
    await this.cgroups();
  }
  async reload() {
    await this.run('/usr/bin/systemctl', ['daemon-reload'], options);
  }
}
