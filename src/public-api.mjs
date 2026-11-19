export { requestLocalDiagnosis } from './diagnosis-request.mjs';
export { observeLocalWork } from './local-work-observation.mjs';
import { managedPreparationCapability } from './managed-resource-contract.mjs';
import { managedSharedAdmission } from './shared-admission-policy.mjs';
import { claudeModelComponent } from './claude-model-runner.mjs';
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
  schemaVersion: interfaceVersion,
  localWorkObservation: Object.freeze({ schemaVersion: 1,
    command: 'observe-local-work', input: 'private-json-stdin' }),
  localDiagnosis: Object.freeze({ schemaVersion: 1,
    command: 'request-local-diagnosis', input: 'private-json-stdin',
    executionAuthority: false }),
  claudeModel: claudeModelComponent,
  managedResourcePreparation: managedPreparationCapability,
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
