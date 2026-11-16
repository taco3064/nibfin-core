import { exclusiveRecovery } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';
import { engine, engineBackend } from './engine-contract.mjs';
import {
  inspectStock, settleStock, verifySettledStock, readUnit, inactiveUnit, runningUnit,
} from './engine-stock.mjs';
import { engineAdmission, engineHost } from './engine-host.mjs';
import { dockerInfo } from './docker-backend.mjs';
import { newEngineProbe, verifyEngineProbe, probeRootfs } from './engine-probe.mjs';

export function managedUnit(unit) {
  const argv = /argv\[\]=([^;]+?)\s*;/.exec(unit.ExecStart)?.[1];
  requireThat(unit.LoadState === 'loaded' && unit.FragmentPath === engine.unitPath &&
    unit.DropInPaths === '' && unit.Environment === '' && unit.EnvironmentFiles === '' &&
    argv === `${engine.daemon} --config-file=${engine.config}`,
  'ENGINE_EFFECTIVE_UNIT_CONFLICT');
}

export async function deliverEngine(io) {
  let state = await io.load();
  if (!state) {
    await io.pristine();
    const stock = await inspectStock(io);
    state = { version: 1, stock, effects: {}, accounts: null, allocation: null };
    await io.save(state, null);
  }
  requireThat(state.version === 1 && state.stock && state.effects,
    'ENGINE_STATE_RECONCILIATION_REQUIRED');
  let saved = structuredClone(state);
  const save = async () => {
    await io.save(state, saved);
    saved = structuredClone(state);
  };
  const effect = async (name, use) => {
    const status = state.effects[name];
    requireThat(status === undefined || ['pending', 'complete'].includes(status),
      'ENGINE_STATE_RECONCILIATION_REQUIRED');
    if (!status) {
      state.effects[name] = 'pending';
      await save();
    }
    await use(status !== undefined);
    state.effects[name] = 'complete';
    await save();
  };
  // Revalidate the original stock inventory immediately before the first handoff.
  if (!state.effects['mask:docker.socket']) {
    const current = await inspectStock(io);
    requireThat(JSON.stringify(current) === JSON.stringify(state.stock),
      'ENGINE_STOCK_CONFIGURATION_CHANGED');
  }
  await io.stockConfiguration();
  for (const [name, unit] of Object.entries(state.stock))
    await io.vendorUnit(unit.FragmentPath, name);
  await settleStock(io, state.stock, effect);
  await effect('accounts', async observe => {
    state.accounts = await io.accounts(observe, state.accounts);
  });
  if (!state.allocation) {
    state.allocation = await io.subordinatePlan(state.accounts);
    await save();
  }
  await effect('subordinates', observe =>
    io.installSubordinates(state.allocation, observe));
  const allocation = await io.subordinatePlan(state.accounts, state.allocation.namespace);
  requireThat(JSON.stringify(allocation.namespace) ===
    JSON.stringify(state.allocation.namespace), 'ENGINE_SUBID_CONFIGURATION_CHANGED');
  await effect('resources', observe => io.resources(state.accounts, observe));
  await effect('reload', async observe => {
    if (!observe) await io.run('/usr/bin/systemctl', ['daemon-reload']).catch(() => {});
    managedUnit(await readUnit(io, engine.unit));
  });
  await effect('enable', async observe => {
    const before = await readUnit(io, engine.unit);
    managedUnit(before);
    if (before.UnitFileState !== 'enabled') {
      requireThat(!observe && before.UnitFileState === 'disabled',
        'ENGINE_ENABLE_RECONCILIATION_REQUIRED');
      await io.run('/usr/bin/systemctl', ['enable', engine.unit]).catch(() => {});
    }
    requireThat((await readUnit(io, engine.unit)).UnitFileState === 'enabled',
      'ENGINE_ENABLE_RECONCILIATION_REQUIRED');
    await io.verifyEnabled();
  });
  await io.beforeStart(state.accounts);
  await effect('start', async observe => {
    await verifySettledStock(io);
    let unit = await readUnit(io, engine.unit);
    managedUnit(unit);
    if (!runningUnit(unit)) {
      requireThat(!observe && inactiveUnit(unit), 'ENGINE_START_RECONCILIATION_REQUIRED');
      await io.daemonProcesses([]);
      await io.run('/usr/bin/systemctl', ['start', engine.unit]).catch(() => {});
      unit = await readUnit(io, engine.unit);
    }
    managedUnit(unit);
    requireThat(runningUnit(unit), 'ENGINE_START_RECONCILIATION_REQUIRED');
    await io.daemonIdentity(unit);
  });
  await io.resources(state.accounts, true);
  await io.access(state.accounts);
  const backend = engineBackend(state.allocation.namespace);
  const info = JSON.parse(await io.docker(true, ['info', '--format', '{{json .}}']));
  dockerInfo(info, backend);
  const namespace = backend.namespace;
  requireThat(info.DockerRootDir ===
    `${engine.data}/${namespace.uidStart}.${namespace.gidStart}` &&
    info.OSType === 'linux' && ['x86_64', 'amd64'].includes(info.Architecture) &&
    info.LiveRestoreEnabled === false && typeof info.ID === 'string' && info.ID,
  'ENGINE_DAEMON_CONFIGURATION_CHANGED');
  // Each invocation obtains fresh kernel evidence, not a cached metadata claim.
  if (state.probe && state.probe.phase !== 'complete')
    requireThat(false, 'ENGINE_PROBE_RECONCILIATION_REQUIRED');
  state.probe = newEngineProbe();
  await save();
  await verifyEngineProbe(io, state.probe, namespace, save);
  await io.access(state.accounts);
  await verifySettledStock(io);
  const final = await readUnit(io, engine.unit);
  managedUnit(final);
  requireThat(runningUnit(final), 'ENGINE_START_RECONCILIATION_REQUIRED');
  await io.daemonIdentity(final);
  const after = JSON.parse(await io.docker(true, ['info', '--format', '{{json .}}']));
  requireThat(dockerInfo(after, backend) === dockerInfo(info, backend),
    'ENGINE_DAEMON_CONFIGURATION_CHANGED');
  return {
    socket: engine.socket, namespace,
    ownership: { uid: 0, gid: state.accounts.gid, unit: engine.unit,
      dataRoot: engine.data, execRoot: engine.exec, remap: engine.remap },
  };
}

// Only the fixed installed administrator entry composes real host capabilities.
export async function installManagedEngine(consent) {
  const confirmSource = await engineAdmission(consent);
  const io = engineHost();
  io.probeRootfs = () => probeRootfs(io);
  await io.probeRootfs();
  await io.initialize();
  return exclusiveRecovery(engine.state, async () => {
    await confirmSource();
    return deliverEngine(io);
  });
}
