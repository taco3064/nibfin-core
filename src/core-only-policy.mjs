import { requireThat, isSha } from './identity.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { optionalStat } from './retirement-files.mjs';
import { classifyCoreOnlyUpdate } from './core-only-compatibility.mjs';
import { currentPoolRuntime, observeCoreOnlyRuntime, prepareCoreOnlyRunnerIdentity }
  from './core-only-runtime.mjs';
import { reobserveCoreMaintenance } from './core-maintenance-identity.mjs';

export async function coreOnlyMaintenanceScope(plan, context, host, reader) {
  requireManagerContext(context);
  return plan.maintenanceInvocation ? reobserveCoreMaintenance(context, host, reader) :
    undefined;
}

export async function inspectCoreOnlyCompatibility(plan, context, {
  prepareIdentity = false,
} = {}) {
  requireManagerContext(context);
  requireThat(plan.mode === 'core-only' && isSha(plan.pin?.commit) && plan.binding,
    'CORE_ONLY_PLAN_REQUIRED');
  const staged = `/opt/nibfin/core-staged-${plan.pin.commit}`;
  const selected = await optionalStat(staged) ? staged :
    await context.installationPath(plan.pin);
  await verifyOwnedSourcePackage(selected, plan.pin);
  const targets = plan.apply?.targets ?? plan.compatibilityTargets;
  requireThat(Array.isArray(targets), 'CORE_ONLY_CONFIGURATION_REQUIRED');
  if (targets.some(target => typeof target.current !== 'string'))
    return { status: 'unsupported', code: 'CORE_ONLY_MAINTENANCE_REQUIRED',
      reasons: ['installation-layout-change'] };
  const hosts = targets.map(target => ({ current: JSON.parse(target.current),
    next: JSON.parse(target.next) }));
  try {
    const runtime = await currentPoolRuntime(context);
    const { before, after } = await observeCoreOnlyRuntime(selected, runtime.target);
    const classification = classifyCoreOnlyUpdate(hosts, before, after);
    if (classification.status !== 'compatible') return classification;
    await prepareCoreOnlyRunnerIdentity(plan.binding, runtime,
      { inspectOnly: !prepareIdentity });
    return classification;
  } catch (error) {
    const known = ['ENOENT', 'INVALID_INSTALLED_RUNNER_IDENTITY',
      'INVALID_RUNNER_RELEASE', 'INVALID_SHARED_EXECUTABLE',
      'INVALID_SHARED_PLATFORM', 'UNSUPPORTED_SHARED_PLATFORM',
      'SHARED_ARTIFACT_DIGEST_MISMATCH', 'SHARED_PLATFORM_MISMATCH'];
    if (!known.includes(error.code)) throw error;
    return { status: 'unsupported', code: 'CORE_ONLY_MAINTENANCE_REQUIRED',
      reasons: [error.code] };
  }
}

export async function requireCoreOnlyCompatibility(plan, context) {
  const result = await inspectCoreOnlyCompatibility(plan, context);
  requireThat(result.status === 'compatible', result.code);
}
