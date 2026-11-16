import { requireThat } from './identity.mjs';

export const stockUnits = ['docker.socket', 'docker.service'];
const properties = [
  'Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath',
  'DropInPaths', 'NeedDaemonReload', 'ExecStart', 'Environment', 'EnvironmentFiles',
  'MainPID', 'Listen', 'Triggers', 'TriggeredBy',
];

export async function readUnit(io, name) {
  const text = await io.run('/usr/bin/systemctl', [
    'show', '--all', `--property=${properties.join(',')}`, name,
  ]);
  const result = {};
  for (const line of text.trimEnd().split('\n')) {
    const split = line.indexOf('=');
    requireThat(split > 0, 'ENGINE_UNIT_READBACK_UNPROVEN');
    const key = line.slice(0, split);
    requireThat(!Object.hasOwn(result, key), 'ENGINE_UNIT_READBACK_UNPROVEN');
    result[key] = line.slice(split + 1);
  }
  const serviceOnly = ['ExecStart', 'Environment', 'EnvironmentFiles', 'MainPID'];
  const required = properties.filter(key => name.endsWith('.socket')
    ? !serviceOnly.includes(key) : key !== 'Listen');
  requireThat(required.every(key => Object.hasOwn(result, key)) &&
    result.Id === name && result.NeedDaemonReload === 'no',
  'ENGINE_UNIT_READBACK_UNPROVEN');
  if (name.endsWith('.socket')) {
    for (const key of serviceOnly) result[key] ??= key === 'MainPID' ? '0' : '';
  } else result.Listen ??= '';
  return result;
}

export const inactiveUnit = unit => unit.ActiveState === 'inactive' &&
  unit.SubState === 'dead' && ['0', ''].includes(unit.MainPID);
export const runningUnit = unit => unit.ActiveState === 'active' &&
  unit.SubState === 'running' && /^[1-9][0-9]*$/.test(unit.MainPID);

export function validateStockUnit(unit, name, masked = false) {
  requireThat(unit.DropInPaths === '' && unit.Environment === '' &&
    unit.EnvironmentFiles === '' && unit.Id === name,
  'ENGINE_STOCK_CUSTOM_CONFIGURATION');
  const links = `${unit.Triggers} ${unit.TriggeredBy}`.trim().split(/\s+/)
    .filter(Boolean);
  requireThat(links.every(link => stockUnits.includes(link)),
    'ENGINE_STOCK_CUSTOM_CONFIGURATION');
  if (masked) {
    requireThat(unit.LoadState === 'masked' && unit.UnitFileState === 'masked' &&
      unit.FragmentPath === '/dev/null' && inactiveUnit(unit),
    'ENGINE_STOCK_RECONCILIATION_REQUIRED');
    return;
  }
  requireThat(unit.LoadState === 'loaded' &&
    ['enabled', 'disabled'].includes(unit.UnitFileState) &&
    ['/usr/lib/systemd/system/', '/lib/systemd/system/'].some(prefix =>
      unit.FragmentPath === `${prefix}${name}`),
  'ENGINE_STOCK_CUSTOM_CONFIGURATION');
  if (name === 'docker.service') {
    const argv = /argv\[\]=([^;]+?)\s*;/.exec(unit.ExecStart)?.[1];
    requireThat(argv === '/usr/bin/dockerd -H fd:// ' +
      '--containerd=/run/containerd/containerd.sock' &&
      (inactiveUnit(unit) || runningUnit(unit)), 'ENGINE_STOCK_CUSTOM_CONFIGURATION');
  } else {
    requireThat(unit.Listen === '/run/docker.sock (Stream)' &&
      (inactiveUnit(unit) || unit.ActiveState === 'active' &&
        unit.SubState === 'listening'), 'ENGINE_STOCK_CUSTOM_CONFIGURATION');
  }
}

export async function stockInventory(io, service) {
  await io.stockConfiguration();
  if (inactiveUnit(service)) {
    await io.emptyStockData();
    return;
  }
  const docker = args => io.docker(false, args);
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  requireThat(info.DockerRootDir === '/var/lib/docker' &&
    info.Containers === 0 && info.Images === 0 &&
    info.Swarm?.LocalNodeState === 'inactive', 'ENGINE_STOCK_WORKLOADS');
  for (const args of [
    ['ps', '-aq'], ['image', 'ls', '-aq'], ['volume', 'ls', '-q'],
    ['plugin', 'ls', '-q'],
  ]) requireThat((await docker(args)).trim() === '', 'ENGINE_STOCK_WORKLOADS');
  const networks = (await docker(['network', 'ls', '--format', '{{json .}}']))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const defaults = { bridge: 'bridge', host: 'host', none: 'null' };
  requireThat(networks.length === 3 && Object.entries(defaults).every(([name, driver]) =>
    networks.filter(row => row.Name === name && row.Driver === driver &&
      row.Scope === 'local').length === 1), 'ENGINE_STOCK_WORKLOADS');
  const usage = (await docker(['system', 'df', '--format', '{{json .}}']))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const types = ['Images', 'Containers', 'Local Volumes', 'Build Cache'];
  requireThat(usage.length === types.length && types.every(type =>
    usage.filter(row => row.Type === type && String(row.TotalCount) === '0')
      .length === 1), 'ENGINE_STOCK_WORKLOADS');
}

export async function inspectStock(io) {
  const result = {};
  for (const name of stockUnits) {
    const unit = await readUnit(io, name);
    validateStockUnit(unit, name);
    await io.vendorUnit(unit.FragmentPath, name);
    result[name] = unit;
  }
  await stockInventory(io, result['docker.service']);
  await io.daemonProcesses([result['docker.service'].MainPID]);
  await io.stockIdentity(result['docker.service']);
  return result;
}

// An interrupted effect is read back on the next invocation before any retry.
// Original state is retained; this installer never re-enables stock activation.
export async function settleStock(io, original, effect) {
  for (const name of stockUnits) {
    await effect(`mask:${name}`, async observe => {
      const unit = await readUnit(io, name);
      if (unit.LoadState !== 'masked') {
        requireThat(!observe, 'ENGINE_STOCK_RECONCILIATION_REQUIRED');
        validateStockUnit(unit, name);
        const before = original[name];
        requireThat(unit.FragmentPath === before.FragmentPath &&
          unit.ExecStart === before.ExecStart && unit.Listen === before.Listen,
        'ENGINE_STOCK_CONFIGURATION_CHANGED');
        await io.run('/usr/bin/systemctl', ['mask', name]).catch(() => {});
      }
      const after = await readUnit(io, name);
      requireThat(after.LoadState === 'masked' &&
        after.UnitFileState === 'masked' && after.FragmentPath === '/dev/null',
      'ENGINE_STOCK_RECONCILIATION_REQUIRED');
      await io.verifyMask(name);
    });
    await effect(`stop:${name}`, async observe => {
      let unit = await readUnit(io, name);
      if (!inactiveUnit(unit)) {
        requireThat(!observe, 'ENGINE_STOCK_RECONCILIATION_REQUIRED');
        await io.run('/usr/bin/systemctl', ['stop', name]).catch(() => {});
        unit = await readUnit(io, name);
      }
      validateStockUnit(unit, name, true);
      await io.verifyMask(name);
    });
  }
  await verifySettledStock(io);
}

export async function verifySettledStock(io) {
  for (const name of stockUnits) {
    validateStockUnit(await readUnit(io, name), name, true);
    await io.verifyMask(name);
  }
}
