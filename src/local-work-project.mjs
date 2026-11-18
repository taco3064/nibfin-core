import { digest } from './identity.mjs';
import { interpretPause } from './pause.mjs';
import { isDeliveredIssue } from './dependencies.mjs';
import { observation, unknown } from './local-work-values.mjs';

export function projectStates({ issue, events, dependencies, evidence, at }) {
  const proofs = [...(evidence.wake?.decisions ?? []),
    ...(evidence.journal?.decisions ?? [])];
  const decisions = [...new Map(proofs.map(proof => [digest(proof), proof])).values()];
  const pause = events
    ? interpretPause({ issue, events, decisions }) : null;
  const qualified = pause?.status === 'clear' || pause?.status === 'paused';
  const pending = evidence.journal?.pending || evidence.wake?.pending;
  const knownJournal = evidence.journal !== null && evidence.wake !== null;
  return {
    pause: qualified
      ? observation(pause.effective, 'github-events+core-decisions', at,
        issue.updated_at, pause.code)
      : unknown('github-events+core-decisions', at, 'PAUSE_UNKNOWN'),
    dependencies: dependencies
      ? observation(dependencies.filter(item => !isDeliveredIssue(item)).length,
        'github-dependencies', at, dependencies.length &&
          dependencies.every(item => Number.isFinite(Date.parse(item.updated_at)))
          ? new Date(Math.min(...dependencies.map(item =>
            Date.parse(item.updated_at)))).toISOString() : null,
        'NATIVE_DEPENDENCIES')
      : unknown('github-dependencies', at, 'DEPENDENCIES_UNKNOWN'),
    executionBlocker: pending
      ? observation('external-effect-unresolved', 'core-journal', at,
        evidence.journal?.sourceTime ?? evidence.wake?.sourceTime,
        'EXTERNAL_EFFECT_UNKNOWN')
      : knownJournal
        ? observation(null, 'core-journal', at, evidence.journal.sourceTime,
          'NO_PENDING_EFFECT')
        : unknown('core-journal', at, 'RUNTIME_UNKNOWN'),
  };
}
export function projectRunner(binding, native, at) {
  const expected = binding.expected;
  const key = `${expected.repositoryId}:${expected.runnerId}`;
  const registration = native.registration.get(key);
  const matches = native.jobs.filter(({ job, repositoryId }) =>
    repositoryId === expected.repositoryId && job.runner_id === expected.runnerId &&
    job.runner_name === expected.runnerName && job.status === 'in_progress');
  const complete = native.repositories.get(
    `${expected.repositoryId}:${expected.workflowId}`)?.complete === true;
  const value = registration?.value;
  let state = 'unknown';
  if (value?.status === 'offline') state = 'offline';
  else if (value?.busy === true) state = 'busy';
  else if (value?.status === 'online' && value.busy === false && complete &&
      matches.length === 0) state = 'idle';
  const field = (value, code) => registration
    ? observation(value, 'github-runner', registration.observedAt, null, code)
    : unknown('github-runner', at, 'REGISTRATION_UNKNOWN');
  return { hostId: binding.hostId,
    adoption: observation(true, 'installed-adoption', at, binding.sourceTime,
      'VERIFIED_ADOPTION'), registration: {
    repository: expected.repository, repositoryId: expected.repositoryId,
    runnerId: expected.runnerId, name: expected.runnerName,
  }, routes: binding.routes, online: field(value?.status === 'online', 'NATIVE_STATUS'),
  busy: field(value?.busy, 'NATIVE_BUSY'), state,
  association: unknown('github-job+core-context', at, 'WORK_UNKNOWN') };
}
export function nativeIdentity(native) {
  return { repository: native.repository, repositoryId: native.repositoryId,
    runId: native.run.id, attempt: native.run.run_attempt, jobId: native.job.id,
    startedAt: Number.isFinite(Date.parse(native.job.started_at))
      ? new Date(native.job.started_at).toISOString() : null, url: native.url };
}
