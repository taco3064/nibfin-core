import { observationFailureCode } from './observation-failure.mjs';
import { types } from 'node:util';

const phases = new Set(['perform', 'read-back', 'complete']);
const causes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EIO', 'ENOSPC',
  'EROFS', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'ELOOP',
  'READBACK_BINDING_MISMATCH', 'INVALID_STAGE_READBACK',
  'INCONSISTENT_STAGE_OUTCOME', 'RECEIPT_PERSISTENCE_FAILED',
  'AGENT_TERMINATION_UNPROVEN', 'UNSAFE_WORKSPACE_PATH',
  'CONTEXT_CHANGED', 'REVIEW_CHANGED_CANDIDATE', 'REBASED_WORKTREE_CHANGED',
  'REVIEW_CANDIDATE_CHANGED', 'PUBLICATION_RECEIPT_MISMATCH',
  'CLAUDE_WORK_INTERRUPTED', 'CLAUDE_MODEL_INTERRUPTED',
]);

function dataValue(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  } catch { return undefined; }
}

function knownCause(error) {
  // Core owns the callbacks, but their exception text can contain tool output,
  // private paths or credentials. Never retain it, even in the private report.
  try {
    const seen = new Set();
    while (error && typeof error === 'object' && !seen.has(error)) {
      seen.add(error);
      const code = dataValue(error, 'code');
      const message = dataValue(error, 'message');
      if (typeof code === 'string' && causes.has(code)) return code;
      if (typeof message === 'string' && causes.has(message)) return message;
      const observation = observationFailureCode({
        code, name: dataValue(error, 'name'), status: dataValue(error, 'status'),
      });
      if (observation !== 'LIVE_OBSERVATION_UNAVAILABLE') return observation;
      error = dataValue(error, 'cause');
    }
  } catch { /* An inaccessible error property is not a cause observation. */ }
  return null;
}

export function localDeliverInterruption(phase, error) {
  return { owner: 'core-local-deliver', phase, cause: knownCause(error) };
}

export function projectLocalInterruption(value) {
  // Snapshot only own data fields. No accessor, proxy trap or value coercion is
  // part of a trusted diagnostic; unknown values cannot carry private payloads.
  const owner = dataValue(value, 'owner');
  const phase = dataValue(value, 'phase');
  const cause = dataValue(value, 'cause');
  if (owner !== 'core-local-deliver' || typeof phase !== 'string' ||
    !phases.has(phase)) return null;
  const safe = typeof cause === 'string' && (causes.has(cause) ||
    observationFailureCode({ code: cause }) === cause ||
    cause === 'LIVE_OBSERVATION_TIMEOUT' || /^LIVE_OBSERVATION_HTTP_[45]\d\d$/
      .test(cause));
  return { owner: 'core-local-deliver', phase,
    cause: safe ? cause : null };
}

export function localInterruptionSummary(value) {
  const observation = projectLocalInterruption(value);
  if (!observation) return null;
  return `Core observed a local Deliver interruption during ${observation.phase}.` +
    (observation.cause ? ` Observed cause code: ${observation.cause}.` :
      ' The underlying cause is unknown.');
}
