import { requireThat } from './identity.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';
import { engine, engineBackend } from './engine-contract.mjs';
import { engineHost } from './engine-host.mjs';
import { managedUnit } from './engine-install.mjs';
import { verifySettledStock, readUnit, runningUnit } from './engine-stock.mjs';
import { dockerInfo } from './docker-backend.mjs';

// Observation only: resource preparation never provisions or repairs the Engine.
export async function verifyManagedEngine(io = engineHost()) {
  const state = await io.load();
  requireThat(state?.version === 1 && state.accounts && state.allocation &&
    state.probe?.phase === 'complete' && state.effects &&
    ['accounts', 'subordinates', 'resources', 'reload', 'enable', 'start',
      'mask:docker.socket', 'stop:docker.socket',
      'mask:docker.service', 'stop:docker.service'].every(
      key => state.effects[key] === 'complete'), 'ENGINE_PREPARATION_NOT_COMPLETE');
  await io.accounts(true, state.accounts);
  const allocation = await io.subordinatePlan(state.accounts, state.allocation.namespace);
  requireThat(JSON.stringify(allocation.namespace) ===
    JSON.stringify(state.allocation.namespace), 'ENGINE_SUBID_CONFIGURATION_CHANGED');
  await io.resources(state.accounts, true);
  await io.access(state.accounts);
  await verifySettledStock(io);
  const unit = await readUnit(io, engine.unit);
  managedUnit(unit);
  requireThat(runningUnit(unit), 'ENGINE_NOT_RUNNING');
  await io.verifyEnabled();
  await io.daemonIdentity(unit);
  const backend = engineBackend(state.allocation.namespace);
  const info = JSON.parse(await io.docker(true, ['info', '--format', '{{json .}}']));
  const identity = dockerInfo(info, backend);
  const n = backend.namespace;
  const architecture = linuxArchitecture(info.OSType, info.Architecture);
  requireThat(info.DockerRootDir === `${engine.data}/${n.uidStart}.${n.gidStart}` &&
    architecture && architecture === (io.architecture ?? 'amd64') &&
    info.LiveRestoreEnabled === false, 'ENGINE_DAEMON_CONFIGURATION_CHANGED');
  return { accounts: state.accounts, namespace: n, identity, architecture };
}
