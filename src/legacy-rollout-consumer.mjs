import { readSystemdUnit } from './owned-systemd-unit.mjs';
import { requireThat } from './identity.mjs';

// Credential use observes the consumer, not whether an unused old file remains.
// Unknown cleanup data does not grant this service permission to run again.
export async function requireNoLegacyRolloutConsumer(observe = readSystemdUnit) {
  const timerName = 'nibfin-rollout.timer';
  const [timer, service] = await Promise.all([
    observe(timerName), observe('nibfin-rollout.service'),
  ]);
  for (const state of [timer, service]) {
    requireThat(['inactive', 'failed'].includes(state.ActiveState) &&
      !['enabled', 'enabled-runtime'].includes(state.UnitFileState),
    'MANAGED_CREDENTIAL_LEGACY_CONSUMER_PENDING');
  }
  requireThat(service.LoadState === 'not-found' || service.MainPID === '0' &&
    service.ControlGroup === '', 'MANAGED_CREDENTIAL_LEGACY_CONSUMER_PENDING');
  requireThat(!service.TriggeredBy || service.TriggeredBy === timerName,
    'MANAGED_CREDENTIAL_LEGACY_CONSUMER_OTHER_TRIGGER');
}
