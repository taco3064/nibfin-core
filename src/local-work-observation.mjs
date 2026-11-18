import { repoPath, issuePath } from './github-read.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { discoverLocalHost } from './local-work-host.mjs';
import { localEvidence } from './local-work-evidence.mjs';
import { boundedList, observationReader } from './local-work-native.mjs';
import { readLocalBindings, correlates, dispatchMatches }
  from './local-work-bindings.mjs';
import { nativeIdentity, projectRunner, projectStates } from './local-work-project.mjs';
import { limits, observation, unknown, reason, subjectIdentity }
  from './local-work-values.mjs';

// Maintained injection seam for controlled development fixtures only. The public
// API below exposes no dependency, state root, member ID or host path parameter.
export async function collectLocalWork(token, {
  reader = observationReader(token), discover = discoverLocalHost,
  evidenceFactory = localEvidence,
} = {}) {
  const startedAt = new Date().toISOString();
  let subject;
  try { subject = subjectIdentity(await reader.get('/user')); }
  catch { return { schemaVersion: 1, status: 'denied', code: 'AUTHENTICATION_DENIED' }; }
  const snapshots = new Map();
  let requestCount = 0;
  const get = async path => {
    requireThat(++requestCount <= limits.requests &&
      Date.now() - Date.parse(startedAt) < limits.milliseconds, 'OBSERVATION_LIMIT');
    return reader.get(path);
  };
  const tracked = { async get(path) {
    requireThat(requestCount + snapshots.size + 2 < limits.requests,
      'OBSERVATION_LIMIT');
    const value = await get(path);
    const hash = digest(value);
    requireThat(!snapshots.has(path) || snapshots.get(path) === hash,
      'OBSERVATION_CHANGED');
    snapshots.set(path, hash);
    return value;
  } };
  const result = { schemaVersion: 1, status: 'observed', subject,
    interval: { startedAt, finishedAt: null }, completeness: 'complete',
    runners: [], work: [], errors: [] };
  const mark = code => {
    result.completeness = 'partial';
    if (!result.errors.includes(code)) result.errors.push(code);
  };
  let host;
  try { host = await discover(subject); }
  catch (error) {
    if (error.code === 'SUBJECT_MISMATCH')
      return { schemaVersion: 1, status: 'denied', code: 'SUBJECT_MISMATCH' };
    mark(reason(error)); result.interval.finishedAt = new Date().toISOString();
    return result;
  }
  host.errors.forEach(mark);
  const evidence = evidenceFactory({ ...host, subjectId: subject.id });
  const native = await readLocalBindings(tracked, host.bindings);
  native.errors.forEach(mark);
  const at = new Date().toISOString();
  result.runners = host.bindings.map(binding => projectRunner(binding, native, at));
  const issues = [];
  for (const route of host.routes) {
    try {
      const repository = await tracked.get(repoPath(route.repository));
      requireThat(repository.id === route.repositoryId &&
        repository.full_name === route.repository && repository.private === false,
      'UNVERIFIED_BINDING');
      const list = await boundedList(tracked,
        `${repoPath(route.repository)}/issues?state=open&labels=scope`);
      requireThat(list.length <= 64, 'OBSERVATION_LIMIT');
      for (const listed of list) {
        if (listed.pull_request) continue;
        const identity = { ...route, number: listed.number, id: listed.node_id };
        requireThat(isId(identity.number) && typeof identity.id === 'string' &&
          /^I_[A-Za-z0-9_-]{1,100}$/.test(identity.id), 'UNVERIFIED_BINDING');
        const issue = await tracked.get(issuePath(identity));
        requireThat(issue.node_id === identity.id && issue.number === identity.number &&
          issue.url === `https://api.github.com${issuePath(identity)}` &&
          !issue.pull_request, 'UNVERIFIED_BINDING');
        const local = await evidence.issue(identity);
        local.errors.forEach(mark);
        let events = null; let dependencies = null;
        try { events = await boundedList(tracked, `${issuePath(identity)}/events`); }
        catch (error) { mark(reason(error)); }
        try {
          dependencies = await boundedList(tracked,
            `${issuePath(identity)}/dependencies/blocked_by`);
          // Only adopted routes may contribute qualified dependency state.
          requireThat(dependencies.every(item => host.routes.some(adopted =>
            item.repository_url ===
              `https://api.github.com${repoPath(adopted.repository)}`)),
          'UNVERIFIED_BINDING');
        } catch (error) { dependencies = null; mark(reason(error)); }
        const states = projectStates({
          issue, events, dependencies, evidence: local, at,
        });
        if (Object.values(states).some(state => state.code.endsWith('UNKNOWN')))
          mark('WORK_STATE_PARTIAL');
        const work = { issue: { ...identity,
          qualified: `${identity.repository}#${identity.number}` },
        issueObservation: observation(true, 'github-issue+installed-adoption', at,
          issue.updated_at, 'VERIFIED_ISSUE'),
        native: null, phase: unknown('core-execution', at, 'PHASE_UNKNOWN'),
        activity: unknown('github-job+core-journal', at, 'ADMISSION_UNKNOWN'),
        ...states };
        issues.push({ identity, local, work });
        result.work.push(work);
      }
    } catch (error) { mark(reason(error)); }
  }
  const phaseConfirmations = [];
  for (const job of native.jobs) {
    const binding = host.bindings.find(item =>
      item.expected.repositoryId === job.repositoryId &&
      item.expected.runnerId === job.job.runner_id &&
      item.expected.runnerName === job.job.runner_name);
    const matches = [];
    const unique = binding && native.jobs.filter(item =>
      item.repositoryId === job.repositoryId &&
      item.job.runner_id === job.job.runner_id).length === 1;
    const runnerObservation = binding
      ? result.runners[host.bindings.indexOf(binding)] : null;
    const activeBinding = unique && runnerObservation.state === 'busy' &&
      runnerObservation.online.value === true;
    if (binding && job.job.status === 'in_progress' && !activeBinding)
      mark('UNVERIFIED_BINDING');
    if (activeBinding && job.job.status === 'in_progress') {
      for (const issue of issues) {
        if (!binding.routes.some(route =>
          route.repositoryId === issue.identity.repositoryId))
          continue;
        for (const candidate of issue.local.contexts) {
          if (correlates(candidate, job, binding, subject.id))
            matches.push({ issue, candidate });
        }
      }
    }
    // One job may span many sequential roles. Multiple contexts for the same
    // Issue can establish Issue identity, but only a unique live role proves phase.
    const matchedIssues = [...new Set(matches.map(match => match.issue))];
    const dispatched = issues.filter(issue =>
      dispatchMatches(issue, job, host.bindings, subject.id));
    const registered = binding && native.registration.has(
      `${binding.expected.repositoryId}:${binding.expected.runnerId}`);
    const queuedDispatch = job.job.status !== 'in_progress' &&
      dispatched.length === 1;
    // Workflow discovery spans other members and hosts. Only an authenticated
    // local registration or qualified dispatch can bring a job into this view.
    if (!registered && !queuedDispatch) continue;
    const issue = matchedIssues.length === 1 ? matchedIssues[0]
      : queuedDispatch ? dispatched[0] : null;
    let record = issue?.work ?? { issue: null,
      phase: unknown('core-execution', at, 'PHASE_UNKNOWN') };
    if (!issue) result.work.push(record);
    if (record.native) {
      record = { ...record, native: null,
        phase: unknown('core-execution', at, 'PHASE_UNKNOWN') };
      result.work.push(record);
    }
    record.native = nativeIdentity(job);
    const activity = job.job.status === 'in_progress' ? 'executing' : 'queued';
    record.activity = observation(activity,
      'github-job', job.observedAt, job.run.updated_at ?? job.job.started_at,
      'NATIVE_JOB');
    if (activeBinding && job.job.status === 'in_progress') {
      runnerObservation.association = observation(record.native, 'github-job', at,
        job.run.updated_at ?? job.job.started_at, 'VERIFIED_JOB');
    }
    const phases = [];
    for (const match of matches) {
      try { phases.push({ ...await evidence.phase(match.candidate),
        sourceTime: match.candidate.sourceTime }); }
      catch (error) {
        if (['OBSERVATION_LIMIT', 'OBSERVATION_CHANGED'].includes(error.code))
          mark(error.code);
      }
    }
    if (issue && phases.length === 1) {
      record.phase = observation(phases[0].stage, 'core-context+kernel-invocation',
        at, phases[0].sourceTime, 'VERIFIED_PHASE');
      phaseConfirmations.push(phases[0].confirm);
    } else if (job.job.status === 'in_progress') mark('PHASE_UNKNOWN');
  }
  for (const issue of issues) {
    const { local, work } = issue;
    const currentDispatch = native.runs.some(run =>
      dispatchMatches(issue, run, host.bindings, subject.id));
    if (!work.native && (local.wake?.dispatchRunId || currentDispatch)) {
      work.activity = observation('dispatched', 'core-wake-journal', at,
        local.wake.sourceTime, 'DISPATCH_CONFIRMED');
    }
    const unassociated = result.work.some(item => item.native && item.issue === null) ||
      result.runners.some(runner => runner.state === 'busy' &&
        runner.association.value === null);
    work.waiting = !work.native && !local.wake?.dispatchRunId && !currentDispatch &&
      !local.wake?.dispatchUnknown && !unassociated && native.errors.length === 0 &&
      host.errors.length === 0 && work.pause.value === false &&
      work.dependencies.value === 0 && work.executionBlocker.code === 'NO_PENDING_EFFECT'
      ? observation('no-admission-observed', 'github+core-journal', at, null, 'WAITING')
      : unknown('github+core-journal', at, 'WAITING_UNKNOWN');
  }
  for (const runner of result.runners) {
    if (runner.state === 'busy' && runner.association.value === null)
      mark('WORK_UNKNOWN');
  }
  try {
    await host.confirm(); await evidence.confirm();
    for (const [path, hash] of snapshots)
      requireThat(digest(await get(path)) === hash, 'OBSERVATION_CHANGED');
    for (const confirm of phaseConfirmations) await confirm();
    requireThat(subjectIdentity(await get('/user')).id === subject.id,
      'SUBJECT_MISMATCH');
  } catch (error) {
    if (error.status === 401 || error.code === 'SUBJECT_MISMATCH')
      return { schemaVersion: 1, status: 'denied', code: 'AUTHENTICATION_DENIED' };
    mark(reason(error));
    // A changing interval cannot support idle, association, phase or work-state
    // assertions. Retain identifiers and explicit unknowns, never a false empty.
    for (const runner of result.runners) {
      runner.state = 'unknown';
      runner.online = unknown('github-runner', at, 'OBSERVATION_CHANGED');
      runner.busy = unknown('github-runner', at, 'OBSERVATION_CHANGED');
      runner.association = unknown('github-job', at, 'OBSERVATION_CHANGED');
    }
    for (const work of result.work) {
      for (const key of ['phase', 'activity', 'pause', 'dependencies',
        'executionBlocker', 'waiting']) {
        if (key in work) work[key] = unknown('interval', at, 'OBSERVATION_CHANGED');
      }
    }
  }
  result.interval.finishedAt = new Date().toISOString();
  if (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes) {
    return { schemaVersion: 1, status: 'observed', subject, interval: result.interval,
      completeness: 'partial', runners: [], work: [], errors: ['OBSERVATION_LIMIT'] };
  }
  return result;
}

export async function observeLocalWork(token) {
  requireThat(typeof token === 'string' && token.length > 0 && token.length <= 16384 &&
    !/[\s\x00-\x1f\x7f]/.test(token), 'INVALID_OBSERVATION_INPUT');
  return collectLocalWork(token);
}
