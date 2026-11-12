import { issuePath, repoPath } from './github-read.mjs';
import { digest, isDigest, isId, requireThat } from './identity.mjs';

const identity = (user) =>
  isId(user?.id) &&
  user.type === 'User' &&
  typeof user.login === 'string' &&
  /^[A-Za-z0-9-]+$/.test(user.login);
const membership = (issue) => {
  requireThat(
    Array.isArray(issue?.labels) &&
      issue.labels.every((label) => typeof label?.name === 'string'),
    'PAUSE_LABELS_UNKNOWN',
  );
  return issue.labels.some((label) => label.name === 'pause');
};

// Qualification has no Runner dependency. Unknown evidence is distinct from a
// positively disqualified actor. Callers must authenticate the native event and
// supply the Issue snapshot at that event, never a later assignment snapshot.
export function pauseQualification({ repository, actor, permission, issue, adding }) {
  if (
    !identity(actor) ||
    !isId(repository?.id) ||
    !['User', 'Organization'].includes(repository.owner?.type) ||
    !isId(repository.owner.id) ||
    !Array.isArray(issue?.assignees) ||
    !['open', 'closed'].includes(issue.state) ||
    !Array.isArray(issue.labels) ||
    issue.labels.some((label) => typeof label?.name !== 'string')
  ) {
    return 'unknown';
  }
  if (
    adding &&
    (issue.state !== 'open' || issue.labels.some((label) => label.name === 'delivered'))
  )
    return 'denied';
  if (repository.owner.type === 'User' && repository.owner.id === actor.id)
    return 'allowed';
  if (
    !identity(permission?.user) ||
    permission.user.id !== actor.id ||
    permission.user.login.toLowerCase() !== actor.login.toLowerCase()
  )
    return 'unknown';
  // GitHub may report triage as the read permission with role_name=triage.
  const native =
    permission.permission === 'read' && permission.role_name === 'triage'
      ? 'triage'
      : permission.permission;
  if (!['none', 'read', 'triage', 'write', 'maintain', 'admin'].includes(native))
    return 'unknown';
  if (repository.owner.type === 'Organization' && native === 'admin') return 'allowed';
  if (!['triage', 'write', 'maintain', 'admin'].includes(native)) return 'denied';
  if (issue.assignees.some((user) => !identity(user))) return 'unknown';
  return issue.assignees.some((user) => user.id === actor.id) ? 'allowed' : 'denied';
}

export function pauseEvent(event) {
  return (
    ['labeled', 'unlabeled'].includes(event?.event) && event.label?.name === 'pause'
  );
}

function history(events) {
  requireThat(Array.isArray(events), 'PAUSE_HISTORY_UNKNOWN');
  let previousId = 0,
    previousTime = -Infinity;
  for (const event of events) {
    const time = Date.parse(event?.created_at);
    requireThat(
      isId(event?.id) &&
        event.id > previousId &&
        Number.isFinite(time) &&
        time >= previousTime &&
        typeof event.event === 'string',
      'PAUSE_HISTORY_INCONSISTENT',
    );
    previousId = event.id;
    previousTime = time;
    if (['labeled', 'unlabeled'].includes(event.event)) {
      requireThat(typeof event.label?.name === 'string', 'PAUSE_HISTORY_MALFORMED');
      if (pauseEvent(event)) requireThat(identity(event.actor), 'PAUSE_ACTOR_UNKNOWN');
    }
  }
}

// These are event qualification receipts from the trusted journal, not a pause
// owner or current-state store. Every receipt binds the immutable native event.
// Missing historical qualification cannot be replaced by today's permissions.
export function interpretPause({ issue, events, decisions = [] }) {
  try {
    history(events);
    requireThat(Array.isArray(decisions), 'PAUSE_DECISIONS_UNKNOWN');
    const seen = new Set();
    let effective = false,
      visible = false;
    for (const event of events.filter(pauseEvent)) {
      const proofs = decisions.filter((proof) => proof.eventHash === digest(event));
      requireThat(proofs.length === 1, 'PAUSE_QUALIFICATION_UNKNOWN');
      const proof = proofs[0];
      requireThat(
        !seen.has(proof.eventHash) &&
          ['allowed', 'denied', 'repair'].includes(proof.qualification) &&
          isDigest(proof.observationHash) &&
          typeof proof.desired === 'boolean',
        'PAUSE_DECISION_INVALID',
      );
      seen.add(proof.eventHash);
      const adding = event.event === 'labeled';
      if (proof.qualification === 'repair') {
        requireThat(
          proof.desired === effective && adding === effective,
          'PAUSE_REPAIR_CONTRADICTED',
        );
      } else {
        if (proof.qualification === 'allowed') effective = adding;
        requireThat(proof.desired === effective, 'PAUSE_DECISION_CONTRADICTED');
      }
      visible = adding;
    }
    requireThat(membership(issue) === visible, 'PAUSE_READBACK_INCONSISTENT');
    const repair = effective !== visible;
    return {
      status: repair ? 'pending' : effective ? 'paused' : 'clear',
      effective,
      visible,
      repair,
      code: repair
        ? 'PAUSE_REPAIR_REQUIRED'
        : effective
          ? 'ISSUE_PAUSED'
          : 'PAUSE_CLEAR',
    };
  } catch (error) {
    return { status: 'pending', code: error.code ?? 'PAUSE_OBSERVATION_UNKNOWN' };
  }
}

function issueIdentity(issue, expected) {
  requireThat(
    issue?.node_id === expected.id &&
      issue.number === expected.number &&
      !issue.pull_request &&
      issue.url === `https://api.github.com${issuePath(expected)}`,
    'PAUSE_ISSUE_CHANGED',
  );
}

// Read history twice around current Issue reads. Pagination failure, churn or
// inconsistent current label membership can never manufacture a clear result.
export async function observePause(reader, expected, decisions = []) {
  try {
    const repository = await reader.repository(expected.repository);
    requireThat(
      repository.id === expected.repositoryId &&
        repository.full_name === expected.repository &&
        repository.private === false,
      'PAUSE_REPOSITORY_CHANGED',
    );
    const before = await reader.issue(expected);
    issueIdentity(before, expected);
    const path = `${issuePath(expected)}/events`;
    const events = await reader.list(path);
    const after = await reader.issue(expected);
    issueIdentity(after, expected);
    const confirmation = await reader.list(path);
    requireThat(
      digest(before) === digest(after) && digest(events) === digest(confirmation),
      'PAUSE_OBSERVATION_CHANGED',
    );
    const state = interpretPause({ issue: after, events, decisions });
    return {
      ...state,
      issue: expected,
      current: after,
      repository,
      events,
      observationHash: digest({ issue: expected, current: after, repository, events }),
    };
  } catch (error) {
    return { status: 'pending', code: error.code ?? 'PAUSE_OBSERVATION_UNKNOWN' };
  }
}

export function requireUnpaused(pause, expected) {
  requireThat(
    pause?.status === 'clear' &&
      pause.effective === false &&
      pause.visible === false &&
      pause.repair === false &&
      digest(pause.issue) === digest(expected) &&
      isDigest(pause.observationHash),
    pause?.status === 'paused' ? 'ISSUE_PAUSED' : 'PAUSE_OBSERVATION_UNKNOWN',
  );
}

// Permission lookups bind the returned native user ID, including triage access.
// A 404/403 is unknown, never a manufactured positive or negative qualification.
export async function qualifyPauseEvent(reader, observation, event, snapshot) {
  requireThat(pauseEvent(event) && identity(event.actor), 'PAUSE_ACTOR_UNKNOWN');
  const { repository } = observation;
  let permission;
  if (!(repository.owner?.type === 'User' && repository.owner.id === event.actor.id)) {
    permission = await reader.get(
      `${repoPath(repository.full_name)}/collaborators/` +
        `${encodeURIComponent(event.actor.login)}/permission`,
    );
  }
  return pauseQualification({
    repository,
    actor: event.actor,
    permission,
    issue: snapshot,
    adding: event.event === 'labeled',
  });
}
