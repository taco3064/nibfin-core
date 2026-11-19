import { requireThat } from './identity.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { requireCoreMaintenance, isOwnMaintenanceJob }
  from './core-maintenance-identity.mjs';
import { settleRolloutWork, requirePromotionWork, readInstalledRolloutFacts }
  from './rollout-pool.mjs';
import { assertRetirementJobs, observeRetirementRegistrations,
  observeRetirementUnit } from './retirement-observe.mjs';
import { command } from './process.mjs';

// Business pool leases, Writer/effect settlement and every other credential
// consumer keep their ordinary checks. Only the authenticated native Job and
// its exact assigned Runner's busy state are maintenance rather than business.
export async function settleCoreOnlyWork(plan, context, maintenanceScope,
  host, reader, binding, options, ports = {}) {
  requireManagerContext(context);
  const admitted = maintenanceScope === undefined ? undefined :
    requireCoreMaintenance(maintenanceScope, context, plan.administratorTarget);
  await settleRolloutWork(host, reader, binding, options, {
    ...(ports.containers ? { containers: ports.containers } : {}),
    jobs: (provider, repositories, pool) => assertRetirementJobs(provider,
      repositories, pool, { allowJob: (repository, run, job) => Boolean(admitted &&
        isOwnMaintenanceJob(maintenanceScope, context, repository, run, job)) }),
    registrations: (provider, pool, settings) => observeRetirementRegistrations(
      provider, pool, { ...settings, allowBusy: runner => Boolean(admitted &&
        runner.id === admitted.provenance.runnerId) }),
  });
}

export async function requireCoreOnlyListeners(plan, unit = observeRetirementUnit) {
  requireThat(plan.originalServices?.length === 2 &&
    [1, 2].every(slot => plan.originalServices.filter(state =>
      state.slot === slot && typeof state.running === 'boolean').length === 1),
  'ROLLOUT_ORIGINAL_SERVICE_STATE_MISSING');
  for (const state of plan.originalServices) {
    const actual = await unit(state.slot, command, { allowActive: true });
    requireThat(actual.ActiveState === (state.running ? 'active' : 'inactive'),
      'CORE_ONLY_LISTENER_STATE_CHANGED');
  }
}

export async function requireCoreOnlyPromotion(plan, context, credentialScope,
  maintenanceScope, ports = {}) {
  requireManagerContext(context);
  requireThat(plan.mode === 'core-only', 'CORE_ONLY_MODE_REQUIRED');
  await requirePromotionWork(plan, credentialScope, { ...ports,
    settle: (host, reader, binding, options) => settleCoreOnlyWork(plan, context,
      maintenanceScope, host, reader, binding, options, ports) });
  await requireCoreOnlyListeners(plan, ports.unit);
}

export async function verifyCoreOnlyInstalled(plan, host, context, credentialScope,
  maintenanceScope, ports = {}) {
  const admitted = maintenanceScope === undefined ? undefined :
    requireCoreMaintenance(maintenanceScope, context, plan.administratorTarget);
  await readInstalledRolloutFacts(plan, host, context, ports,
    runner => Boolean(admitted && runner.id === admitted.provenance.runnerId));
  await requireCoreOnlyPromotion(plan, context, credentialScope, maintenanceScope, ports);
}
