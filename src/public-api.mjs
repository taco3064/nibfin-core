export { requestLocalDiagnosis } from './diagnosis-request.mjs';
export { observeLocalWork } from './local-work-observation.mjs';
import { managedPreparationCapability } from './managed-resource-contract.mjs';
import { managedSharedAdmission } from './shared-admission-policy.mjs';
import { claudeModelComponent } from './claude-model-runner.mjs';
import { coreMaintenanceContract } from './core-maintenance-contract.mjs';
export { createClaudePrivateRunner } from './claude-model-runner.mjs';

// Versioned public exports. Thin consumers call Core; they must not copy its
// lifecycle, selection, acceptance or merge policy into their own repositories.
export { StageRuntime } from './stage-runtime.mjs';
export { nativeStageExecutor, runStageInput } from './native-stage.mjs';
export { installedStageExecutor } from './installed-stage.mjs';
export { codexStageExecutor } from './codex-stage.mjs';
export { nativeObserver } from './native-observer.mjs';
export { nativeWrites } from './native-writes.mjs';
export { stageHandlers } from './stage-handlers.mjs';
export { WakeDispatcher, observeWake, fanout } from './wakeup.mjs';
export { resolveWakeDispatch } from './wake-entry.mjs';
export { packageSource, verifyInstalledSource } from './source-package.mjs';
export { installSource } from './source-install.mjs';
export { command, deliveryTransportTimeout } from './process.mjs';

export {
  releaseAssets,
  planRelease,
  ReleaseDraft,
  verifyPublishedRelease,
} from './release.mjs';

export { sharedDispatchWorkflow, sharedRepository } from './shared-runner.mjs';

export const interfaceVersion = 1;
export const consumerContract = Object.freeze({
  officialRunnerRefresh: Object.freeze({
    schemaVersion: 1, command: 'refresh-runner-runtime',
    modes: Object.freeze(['preview', 'apply', 'resume']),
    statuses: Object.freeze(['preview', 'current', 'refreshed', 'pending']),
    exitStatuses: Object.freeze({ pending: 2, denied: 1, success: 0 }),
    authority: 'external local administrator on the adopted installed host',
    preserves: 'Core, credentials, registrations, Owner pause and stopped services',
    continuation: 'complete-installed-lifecycle after operation admission release',
  }),
  schemaVersion: interfaceVersion,
  localWorkObservation: Object.freeze({ schemaVersion: 1,
    command: 'observe-local-work', input: 'private-json-stdin' }),
  localDiagnosis: Object.freeze({ schemaVersion: 1,
    command: 'request-local-diagnosis', input: 'private-json-stdin',
    executionAuthority: false }),
  claudeModel: claudeModelComponent,
  managedResourcePreparation: managedPreparationCapability,
  administratorCoreRollout: Object.freeze({
    schemaVersion: 1, command: 'rollout-core',
    preparationCommand: 'install-core-rollout-manager',
    input: 'native CD run ID and activation artifact ID',
    requires: 'root administrator outside the affected Runner pool',
    retry: 'same explicit target; authoritative readback before repeating writes',
    installation: Object.freeze(['complete', 'pending']),
    continuation: Object.freeze(['dispatched', 'paused', 'pending']),
  }),
  coreOnlyRollout: Object.freeze({ ...coreMaintenanceContract,
    command: 'rollout-core-only', input: 'native CD run ID and activation artifact ID',
    preparationCommand: 'install-core-rollout-manager',
    listenerActions: 'none', runtimeReplacement: false,
    unsupported: 'CORE_ONLY_MAINTENANCE_REQUIRED',
    maintenanceAuthorization: 'signed GitHub OIDC and exact native assigned Job',
    consumer: 'separate fixed administrator bridge; ordinary Issue jobs are denied',
  }),
  installedLifecycleCompletion: Object.freeze({
    schemaVersion: 1, command: 'complete-installed-lifecycle', input: 'none',
    requires: 'local administrator on the adopted installed host',
    statuses: Object.freeze(['dispatched', 'paused', 'pending']),
    exitStatuses: Object.freeze({ dispatched: 0, paused: 0, pending: 2, denied: 1 }),
    dispatched: 'Successful current scan and confirmed requests; not delivery',
    retry: 'Observe current state again and reuse lifecycle-compatible confirmations',
  }),
  managedPoolReplacement: Object.freeze({
    kind: 'managed-pool-replacement-v1',
    activationCommand: 'activate-shared-replacement',
  }),
  notificationRelayRetirement: Object.freeze({
    schemaVersion: 1, command: 'retire-notification-relay', input: 'none',
    requires: 'local administrator on the adopted installed host',
    statuses: Object.freeze(['retired', 'pending']),
    exitStatuses: Object.freeze({ retired: 0, pending: 2, denied: 1 }),
    retained: 'Owner pause, unknown effects and unrelated resources are preserved',
    independent: 'Native activation and lifecycle completion do not require cleanup',
  }),
  managedSharedAdmission: Object.freeze({
    kind: managedSharedAdmission,
    adoptionProfileKey: 'sharedAdmission',
    nativeRepositoryPolicy: true,
    dispatchObservation: 'sharedDispatchWorkflow',
    repositoryObservation: 'sharedRepository',
  }),
  requestKeys: Object.freeze(['schemaVersion', 'stage']),
  stages: Object.freeze([
    'shape',
    'validate-shape',
    'publish-shape',
    'deliver',
    'pre-accept-hooks',
    'accept',
    'post-accept-hooks',
    'commit-pr',
    'review-pr',
    'merge',
    'close',
  ]),
  outcomes: Object.freeze(['completed', 'denied', 'pending']),
  eventAuthority: false,
  requiresPrivateKairo: false,
});
