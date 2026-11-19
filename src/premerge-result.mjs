import { stages } from './stages.mjs';

// A merge-stage refusal can precede all merge effects. Success cannot.
// Callers must still prove settlement and the absence of merge effects.
export function premergeResult(stage, status) {
  return Object.hasOwn(stages, stage) && stage !== 'close' &&
    (stage !== 'merge' || ['denied', 'pending'].includes(status));
}
