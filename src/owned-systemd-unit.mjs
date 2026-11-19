import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';

export async function readSystemdUnit(name, {
  run = command, inspect = rootOwnedPath,
} = {}) {
  await inspect('/usr/bin/systemctl');
  const { stdout } = await run('/usr/bin/systemctl', ['show', name, '--all',
    '--property=Id,LoadState,FragmentPath,DropInPaths,ActiveState,UnitFileState',
    '--property=MainPID,ControlGroup,NeedDaemonReload',
    '--property=RequiredBy,BoundBy,ConsistsOf,TriggeredBy,WantedBy'],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const state = Object.fromEntries(stdout.toString().trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  requireThat(state.Id === name, 'SYSTEMD_UNIT_IDENTITY_UNKNOWN');
  return state;
}

export async function readOwnedSystemdUnit(name, fragment, {
  run = command, inspect = rootOwnedPath, code = 'SYSTEMD_UNIT_NOT_OWNED',
} = {}) {
  const state = await readSystemdUnit(name, { run, inspect });
  requireThat(state.DropInPaths === '' &&
    (state.LoadState === 'not-found' && state.FragmentPath === '' ||
      state.LoadState === 'loaded' && state.FragmentPath === fragment), code);
  return state;
}

export function ownedSystemdUnitStopped(unit, name) {
  if (!['inactive', 'failed'].includes(unit.ActiveState)) return false;
  if (name.endsWith('.timer'))
    return ['disabled', '', 'not-found'].includes(unit.UnitFileState);
  return unit.LoadState === 'not-found' ||
    unit.MainPID === '0' && unit.ControlGroup === '';
}
