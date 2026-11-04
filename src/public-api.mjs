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
export { command } from './process.mjs';

export {
  releaseAssets,
  planRelease,
  ReleaseDraft,
  verifyPublishedRelease,
} from './release.mjs';

export const interfaceVersion = 1;
export const consumerContract = Object.freeze({
  schemaVersion: interfaceVersion,
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
