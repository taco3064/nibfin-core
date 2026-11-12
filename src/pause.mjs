import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { issuePath, repoPath } from './github-read.mjs';

export function pauseEvent(event) {
  return ['labeled', 'unlabeled'].includes(event?.action) &&
    event.label?.name === 'pause';
}

export function pauseLabels(issue) {
  requireThat(Array.isArray(issue?.labels) && issue.labels.every(label =>
    typeof label?.name === 'string' && label.name), 'PAUSE_LABELS_UNKNOWN');
  const names = issue.labels.map(label => label.name).sort();
  requireThat(new Set(names).size === names.length, 'PAUSE_LABELS_UNKNOWN');
  return names;
}

export function pauseIssue(issue, identity) {
  requireThat(issue?.node_id === identity.id && issue.number === identity.number &&
    !issue.pull_request &&
    issue.url === `https://api.github.com${issuePath(identity)}` &&
    ['open', 'closed'].includes(issue.state), 'PAUSE_ISSUE_CHANGED');
  pauseLabels(issue);
}

function actorIdentity(actor) {
  requireThat(isId(actor?.id) && ['User', 'Bot'].includes(actor.type) &&
    typeof actor.login === 'string' && /^[A-Za-z0-9\[\]-]+$/.test(actor.login),
  'PAUSE_ACTOR_UNKNOWN');
}

// Native permission is separate from delivery/Runner membership. Triage can edit
// labels, but cannot grant delivery authority. Identity must match the endpoint.
export async function labelPermission(reader, repository, actor) {
  actorIdentity(actor);
  const result = await reader.get(`${repoPath(repository)}/collaborators/` +
    `${encodeURIComponent(actor.login)}/permission`);
  requireThat(result?.user?.id === actor.id && result.user.login === actor.login &&
    result.user.type === actor.type && typeof result.permission === 'string',
  'PAUSE_PERMISSION_UNKNOWN');
  const admin = result.permission === 'admin';
  const edit = admin || ['write', 'triage'].includes(result.permission) ||
    result.role_name === 'triage' || result.user.permissions?.triage === true ||
    result.user.permissions?.push === true;
  return { admin, edit };
}

function personalOwner(repository, actor) {
  return actor.type === 'User' && repository.owner.type === 'User' &&
    repository.owner.id === actor.id;
}

async function qualifies(reader, repository, issue, actor, desired = true) {
  actorIdentity(actor);
  if (desired && (issue.state !== 'open' || pauseLabels(issue).includes('delivered')))
    return false;
  if (actor.type !== 'User') return false;
  if (personalOwner(repository, actor)) return true;
  requireThat(Array.isArray(issue.assignees) &&
    issue.assignees.every(user => isId(user?.id)), 'PAUSE_ASSIGNMENT_UNKNOWN');
  const assigned = issue.assignees.some(user => user.id === actor.id);
  if (repository.owner.type === 'User' && !assigned) return false;
  const permission = await labelPermission(reader, repository.full_name, actor);
  return (repository.owner.type === 'Organization' && permission.admin) ||
    (assigned && permission.edit);
}

export function pauseSnapshot(issue) {
  return { id: issue.node_id, number: issue.number, url: issue.url,
    state: issue.state, body: issue.body, labels: pauseLabels(issue),
    assignees: issue.assignees ?? null, updatedAt: issue.updated_at ?? null };
}

async function assessEvent(reader, event, events, repository) {
  if (!pauseEvent(event)) return undefined;
  const desired = event.action === 'labeled';
  const snapshot = event.issue;
  if (!isId(event.sender?.id) || !['open', 'closed'].includes(snapshot?.state) ||
    !Array.isArray(snapshot.labels) || !Array.isArray(snapshot.assignees) ||
    !snapshot.assignees.every(user => isId(user?.id))) return undefined;
  const labels = pauseLabels(snapshot);
  if (labels.includes('pause') !== desired) return undefined;
  const matches = events.filter(item => item.event === event.action &&
    item.actor?.id === event.sender?.id &&
    item.created_at === snapshot.updated_at);
  if (matches.length !== 1 || matches[0] !== events.at(-1)) return undefined;
  const native = matches[0];
  const allowed = await qualifies(reader, repository, snapshot, native.actor, desired)
    .catch(() => undefined);
  return { id: native.id, allowed };
}

function eventProof(proofs, identity, event, prefix) {
  if (!event) return undefined;
  return proofs.find(item => item.eventId === event.id &&
    item.actorId === event.actor?.id && item.desired === (event.event === 'labeled') &&
    item.issueId === identity.id && item.repositoryId === identity.repositoryId &&
    item.beforeHash === digest(prefix));
}

// A complete bounded native list, read twice, is mandatory even when the visible
// label is absent. No event payload, bot login or label absence proves Resume.
export async function observePause(reader, identity, proofs = [], event) {
  try {
    const repository = await reader.repository(identity.repository);
    requireThat(repository.id === identity.repositoryId &&
      repository.full_name === identity.repository && repository.private === false &&
      isId(repository.owner?.id) &&
      ['User', 'Organization'].includes(repository.owner.type),
    'PAUSE_REPOSITORY_CHANGED');
    const issue = await reader.issue(identity);
    pauseIssue(issue, identity);
    const path = `${issuePath(identity)}/events`;
    const all = await reader.list(path);
    requireThat(Array.isArray(all), 'PAUSE_HISTORY_UNKNOWN');
    requireThat(all.every(event => event && typeof event.event === 'string' &&
      (!['labeled', 'unlabeled'].includes(event.event) ||
        typeof event.label?.name === 'string')), 'PAUSE_HISTORY_UNKNOWN');
    const events = all.filter(event =>
      ['labeled', 'unlabeled'].includes(event?.event) && event.label?.name === 'pause');
    const assessment = await assessEvent(reader, event, events, repository);
    let previousId = 0, previousTime = 0, visible = false, owner = null;
    let uncertainOwner = false;
    let rejectedEventId, authorization;
    const prefix = [], qualifications = new Map();
    for (const [index, event] of events.entries()) {
      const time = Date.parse(event.created_at);
      requireThat(isId(event.id) && event.id > previousId &&
        Number.isFinite(time) && time >= previousTime &&
        event.url === `https://api.github.com${repoPath(identity.repository)}/` +
          `issues/events/${event.id}`, 'PAUSE_HISTORY_UNKNOWN');
      actorIdentity(event.actor);
      previousId = event.id;
      previousTime = time;
      const desired = event.event === 'labeled';
      requireThat(desired || visible, 'PAUSE_HISTORY_INCONSISTENT');
      const proof = eventProof(proofs, identity, event, prefix);
      const observed = !proof && assessment?.id === event.id
        ? assessment.allowed : undefined;
      if (!proof && observed === true) authorization = {
        issueId: identity.id, repositoryId: identity.repositoryId,
        eventId: event.id, actorId: event.actor.id, desired, beforeHash: digest(prefix),
        authorized: true,
      };
      if (desired && owner && !visible && event.actor.type === 'Bot')
        requireThat(proof, 'PAUSE_RESTORATION_UNPROVEN');
      if (proof && !proof.authorized) {
        requireThat(desired === Boolean(owner) || (!desired && uncertainOwner),
          'PAUSE_REPAIR_PROOF_CONFLICT');
        if (!desired) { owner = null; uncertainOwner = false; }
      } else if (desired && !owner) {
        const next = eventProof(proofs, identity, events[index + 1],
          [...prefix, event]);
        if (observed === false || next?.rejectedEventId === event.id) {
          if (observed === false) rejectedEventId = event.id;
          visible = true;
          prefix.push(event);
          continue;
        }
        const accepted = proof?.authorized || observed === true;
        if (!accepted && !qualifications.has(event.actor.id)) {
          qualifications.set(event.actor.id,
            await qualifies(reader, repository, issue, event.actor)
              .catch(() => undefined));
        }
        const qualified = accepted || qualifications.get(event.actor.id);
        // Historical uncertainty retains the pause until an authorized removal.
        if (qualified || event.actor.type === 'User') {
          owner = event.actor.id;
          uncertainOwner = !qualified;
        }
      } else if (!desired && (proof?.authorized || observed === true ||
        personalOwner(repository, event.actor))) {
        owner = null;
        uncertainOwner = false;
      }
      visible = desired;
      prefix.push(event);
    }
    const current = await reader.issue(identity);
    pauseIssue(current, identity);
    requireThat(digest(pauseSnapshot(issue)) === digest(pauseSnapshot(current)) &&
      digest(await reader.list(path)) === digest(all) &&
      digest(await reader.repository(identity.repository)) === digest(repository),
    'PAUSE_OBSERVATION_CHANGED');
    const present = pauseLabels(current).includes('pause');
    requireThat(present === visible, 'PAUSE_HISTORY_INCONSISTENT');
    const effective = Boolean(owner), repair = present !== effective;
    const snapshot = { identity, issue: pauseSnapshot(current), events, repository };
    const status = uncertainOwner ? 'unknown' :
      repair ? 'repair' : effective ? 'paused' : 'clear';
    return { status,
      issueId: identity.id, repositoryId: identity.repositoryId,
      observationHash: digest(snapshot), desired: effective, present,
      events, current, ...(owner ? { actorId: owner } : {}),
      ...(rejectedEventId ? { rejectedEventId } : {}),
      ...(authorization ? { authorization } : {}) };
  } catch (error) {
    return { status: 'unknown', issueId: identity.id,
      repositoryId: identity.repositoryId, code: error.code ?? 'PAUSE_HISTORY_UNKNOWN' };
  }
}

export function requirePauseClear(pause, identity, issue) {
  requireThat(pause?.status === 'clear' && pause.issueId === identity.id &&
    pause.repositoryId === identity.repositoryId &&
    isDigest(pause.observationHash) && !pauseLabels(issue).includes('pause') &&
    digest(pauseSnapshot(pause.current)) === digest(pauseSnapshot(issue)),
  'PAUSE_NOT_PROVEN_CLEAR');
}
