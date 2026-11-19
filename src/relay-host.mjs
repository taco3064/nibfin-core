import { isId, isSha, requireThat } from './identity.mjs';
import { loadAdoptedHost, currentAdoptedOrigins } from './adopted-host.mjs';
import { RelayReader } from './relay-http.mjs';
import { observeRelayOrigin } from './relay-observe.mjs';
import { RelayJournal } from './relay-state.mjs';
export { bindAdoptedOrigin as bindRelayOrigin } from './adopted-host.mjs';

export const relayConfigFile = '/etc/nibfin/notification-relay.json';
export const relayStateRoot = '/var/lib/nibfin/notification-relay';
export const relayUnitDirectory = '/etc/systemd/system';
export const relayUnits = ['nibfin-notification-relay.service',
  'nibfin-notification-relay.timer'];

export function validateRelayConfiguration(value) {
  requireThat(value?.schemaVersion === 1 && Object.keys(value).sort().join(',') ===
    'origins,schemaVersion' && Array.isArray(value.origins) &&
    value.origins.length > 0 && value.origins.length <= 10,
  'INVALID_RELAY_CONFIGURATION');
  const ids = new Set();
  for (const origin of value.origins) {
    const workflow = origin?.workflow;
    requireThat(Object.keys(origin).sort().join(',') ===
      'ref,repository,repositoryId,workflow' && isId(origin.repositoryId) &&
      !ids.has(origin.repositoryId) && typeof origin.repository === 'string' &&
      typeof origin.ref === 'string' && origin.ref.length > 0 &&
      origin.ref.length <= 255 && !/[\x00-\x20]/.test(origin.ref) &&
      workflow && Object.keys(workflow).sort().join(',') === 'blob,commit,id,path' &&
      isId(workflow.id) && isSha(workflow.commit) && isSha(workflow.blob) &&
      workflow.path === '.github/workflows/nibfin-issue.yml',
    'INVALID_RELAY_CONFIGURATION');
    ids.add(origin.repositoryId);
  }
  return value;
}

export async function currentRelayOrigins(host, readPeer) {
  return (await currentAdoptedOrigins(host, readPeer)).origins;
}

export async function loadRelayHost({ currentAdoption = false, ...options } = {}) {
  const context = await loadAdoptedHost({ ...options,
    configuration: currentAdoption ? currentAdoptedOrigins : async (host, read) =>
      validateRelayConfiguration(await read(relayConfigFile)),
    readerClass: currentAdoption ? undefined : RelayReader,
    verifyOrigins: async (reader, origins, commit) => {
      if (!currentAdoption)
        for (const origin of origins) await observeRelayOrigin(reader, origin, commit);
    } });
  return { ...context, journal: new RelayJournal(relayStateRoot) };
}
