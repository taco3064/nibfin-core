import { isDeepStrictEqual } from 'node:util';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { observeCoreMaintenanceFrame } from './core-maintenance-identity.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { rolloutPlanPath, rolloutClosurePath, rolloutMarker }
  from './rollout-admission.mjs';
import { requireNoRetirement, requirePoolOpen } from './retirement-admission.mjs';
import { requireThat, isId } from './identity.mjs';

// The fixed Root-owned pre-Worker bridge supplies the original Listener frame.
// This only permits the official Worker to start. It never creates a promotion
// scope, persists provenance or grants the later operation a different target.
export async function observeCoreMaintenanceWorker(context, host, message,
  actualInvokerUid, reader) {
  requireManagerContext(context);
  const provenance = await observeCoreMaintenanceFrame(context, host, message,
    actualInvokerUid, reader);
  await requireNoRetirement({ rollout: true });
  const closure = await readRetirementFile(rolloutClosurePath);
  if (!closure) {
    await requirePoolOpen();
    return provenance;
  }
  const plan = await readRetirementFile(rolloutPlanPath);
  const { schemaVersion: unused, ...pool } = managerHostRegistrations(host, context);
  void unused;
  requireThat(plan?.schemaVersion === 2 && plan.mode === 'core-only' &&
    isId(plan.administratorTarget?.runId) && isId(plan.administratorTarget?.artifactId) &&
    plan.pin?.repository === provenance.repository &&
    isDeepStrictEqual(plan.binding?.pool, pool) &&
    isDeepStrictEqual(closure, rolloutMarker(plan)),
  'CORE_MAINTENANCE_CLOSURE_CHANGED');
  return provenance;
}
