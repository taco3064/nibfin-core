import { observePause, pauseEvent, requireUnpaused } from './pause.mjs';
import { GitHubReader, repoPath } from './github-read.mjs';
import {
  readProtectedApproval,
  readMemberPermission,
} from './github-approval.mjs';
import { readDependencies, isDeliveredIssue } from './dependencies.mjs';
import { selectAssignee } from './selection.mjs';
import { bindRawScope } from './approval-record.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource } from './caller-source.mjs';
import { wakeRecipe } from './caller-recipes.mjs';

function wakeObservationCode(error, fallback) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
    return `GITHUB_READ_HTTP_${error.status}`;
  if (error?.name === 'TimeoutError') return 'WAKE_OBSERVATION_TIMEOUT';
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
    ? error.code : fallback;
}

// Runs on a trusted hosted preflight, before selecting a self-hosted Runner.
// Events only locate an adopted Issue identity. No event field grants authority.
export async function observeWake(
  reader,
  { approvalPin, workflow, actorId, shared = false, pauseDecisions = [],
    routingOnly = false },
  clock = Date.now,
) {
  requireThat(
    isId(actorId) &&
      isId(workflow?.id) &&
      /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow.path),
    'INVALID_WAKE_PIN',
  );
  const approval = await readProtectedApproval(reader, approvalPin, clock());
  const nativePolicy = approvalPin.kind === 'repository-admission-v1';
  const record = approval.record,
    issue = record.issue,
    root = repoPath(issue.repository);
  requireThat(record.operations.includes('wake'), 'WAKE_NOT_APPROVED');
  const dependencies = await readDependencies(reader, issue, record.prerequisites);
  const current = dependencies.issue;
  const pause = await observePause(reader, issue, pauseDecisions);
  if (!routingOnly) {
    requireUnpaused(pause, issue);
    requireThat(digest(pause.current) === digest(current), 'PAUSE_OBSERVATION_CHANGED');
  }
  requireThat(
    current.labels.some((label) => label.name === 'scope') &&
      !current.labels.some((label) => label.name === 'delivered'),
    'INACTIVE_WAKE_TARGET',
  );
  // Shaped work is not reconstructed from mutable text here. Its full evidence
  // is checked at execution admission; a wake never grants stage permission.
  if (!current.labels.some((label) => label.name === 'shaped'))
    bindRawScope(record, current);
  const route = await selectAssignee(current, async (user) => {
    if (user.id !== record.roles.writer) return false;
    if (!nativePolicy)
      await readMemberPermission(reader, issue.repository, { ...user, type: 'User' });
    return true;
  });
  requireThat(route && dependencies.ready, 'WAKE_TARGET_NOT_READY');
  const entryStage = current.labels.some((label) => label.name === 'shaped')
    ? 'deliver'
    : 'shape';
  requireThat(
    record.operations.includes(entryStage) &&
      record.roles[entryStage === 'shape' ? 'author' : 'writer'] === route.userId,
    'WAKE_ENTRY_NOT_APPROVED',
  );
  const actor = await reader.get('/user');
  requireThat(
    actor.type === 'User' && actor.id === actorId && actor.id === record.roles.publisher,
    'WAKE_ACTOR_CHANGED',
  );
  if (!nativePolicy) await readMemberPermission(reader, issue.repository, actor);
  const observed = {
    issue,
    approvalHash: approval.approvalHash,
    actorId,
    route,
    entryStage,
    pause,
    state: {
      body: current.body,
      labels: current.labels,
      assignees: current.assignees,
      prerequisites: dependencies.prerequisites,
    },
  };
  if (shared) return observed;
  const repository = await reader.repository(issue.repository);
  const branch = await reader.get(
    `${root}/branches/${encodeURIComponent(repository.default_branch)}`,
  );
  requireThat(nativePolicy || branch.protected === true, 'WAKE_WORKFLOW_SOURCE_CHANGED');
  const commit = await readCallerSource(
    reader,
    issue.repository,
    workflow,
    branch.commit?.sha,
    workflow.actionCommit === undefined && branch.commit?.sha === workflow.commit
      ? undefined : wakeRecipe(record.source.commit, workflow, route.userId),
  );
  const actual = await reader.get(`${root}/actions/workflows/${workflow.id}`);
  requireThat(
    actual.id === workflow.id &&
      actual.path === workflow.path &&
      actual.state === 'active',
    'WAKE_WORKFLOW_UNAVAILABLE',
  );
  return {
    ...observed,
    workflow: { ...workflow, commit, ref: repository.default_branch },
  };
}

function pauseBinding(pause) {
  if (!pause) return null;
  const { status, effective, visible, repair, events } = pause;
  return { status, effective, visible, repair, events: events.filter(pauseEvent) };
}

// The native 2026-03-10 dispatch endpoint returns the actual run ID. A 204 or
// lost response is unknown, never permission to dispatch again. The returned
// receipt means a matching run was observed, not that its stage was admitted.
export class WakeDispatcher {
  #reader;
  #token;
  #observe;
  #journal;
  #fetch;
  constructor({ token, observe, journal, fetcher = fetch }) {
    requireThat(
      typeof token === 'string' &&
        token.trim() &&
        typeof observe === 'function' &&
        typeof journal?.run === 'function',
      'INVALID_WAKE_ADAPTER',
    );
    this.#reader = new GitHubReader(token, fetcher);
    this.#token = token;
    this.#observe = observe;
    this.#journal = journal;
    this.#fetch = fetcher;
  }
  async dispatch() {
    let initial;
    try {
      initial = await this.#observe(this.#reader);
    } catch (error) {
      return { status: 'denied',
        code: wakeObservationCode(error, 'WAKE_OBSERVATION_UNAVAILABLE') };
    }
    const bindingHash = digest(initial);
    const { issue } = initial;
    let workflow = initial.workflow;
    const destination = () => workflow.repository ?? issue.repository;
    const destinationId = () => workflow.repositoryId ?? issue.repositoryId;
    let admissionCode;
    const result = await this.#journal.run(
      { operation: 'wake', bindingHash },
      {
        admit: async () => {
          try {
            const current = await this.#observe(this.#reader);
            requireThat(
              current.issue.id === issue.id &&
                current.issue.repositoryId === issue.repositoryId &&
                current.issue.repository === issue.repository &&
                current.issue.number === issue.number &&
                current.actorId === initial.actorId &&
                current.workflow.repository === workflow.repository &&
                current.workflow.repositoryId === workflow.repositoryId &&
                current.workflow.id === workflow.id &&
                current.workflow.path === workflow.path,
              'WAKE_TARGET_CHANGED',
            );
            requireThat(
              digest(pauseBinding(current.pause)) === digest(pauseBinding(initial.pause)),
              'WAKE_PAUSE_CHANGED',
            );
            workflow = current.workflow;
          } catch (error) {
            admissionCode = wakeObservationCode(error, 'ADMISSION_FAILED');
            throw error;
          }
          return bindingHash;
        },
        perform: async () => {
          const response = await this.#fetch(
            'https://api.github.com' +
              `${repoPath(destination())}/actions/workflows/${workflow.id}/dispatches`,
            {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(30000),
              headers: {
                Authorization: `Bearer ${this.#token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2026-03-10',
              },
              body: JSON.stringify({
                ref: workflow.ref,
                inputs: {
                  issue_number: String(issue.number),
                  issue_id: issue.id,
                  repository_id: String(issue.repositoryId),
                },
              }),
            },
          );
          requireThat(response.status === 200, 'DISPATCH_RESULT_UNKNOWN');
          const receipt = await response.json();
          const runId = receipt.workflow_run_id;
          requireThat(
            isId(runId) &&
              receipt.run_url ===
                'https://api.github.com' +
                  `${repoPath(destination())}/actions/runs/${runId}` &&
              receipt.html_url ===
                `https://github.com/${destination()}/actions/runs/${runId}`,
            'DISPATCH_IDENTITY_UNKNOWN',
          );
          return runId;
        },
        readBack: async (runId) => {
          const run = await this.#reader.get(
            `${repoPath(destination())}/actions/runs/${runId}`,
            { retryNotFound: true },
          );
          requireThat(
            run.id === runId &&
              run.event === 'workflow_dispatch' &&
              run.workflow_id === workflow.id &&
              run.path === workflow.path &&
              run.repository?.id === destinationId() &&
              run.head_repository?.id === destinationId() &&
              run.head_sha === workflow.commit &&
              run.head_branch === workflow.ref &&
              run.actor?.id === initial.actorId &&
              run.run_attempt === 1,
            'DISPATCH_RUN_MISMATCH',
          );
          return bindingHash;
        },
      },
    );
    return result.status === 'completed'
      ? { status: 'scheduled', runId: result.runId, bindingHash, stageAdmitted: false }
      : admissionCode ? { ...result, code: admissionCode } : result;
  }
}

// Read the live reverse edge list; do not save a parallel dependency graph or
// discover arbitrary configuration from downstream Issue text.
export async function fanout(reader, upstream, { approvedTarget, wake }) {
  const verifyClosed = async () => {
    const repository = await reader.repository(upstream.repository),
      issue = await reader.issue(upstream);
    requireThat(
      repository.id === upstream.repositoryId &&
        repository.full_name === upstream.repository &&
        repository.private === false &&
        issue.node_id === upstream.id &&
        issue.number === upstream.number &&
        !issue.pull_request &&
        issue.state === 'closed' &&
        issue.url ===
          `https://api.github.com/repos/${upstream.repository}/issues/${upstream.number}`,
      'UPSTREAM_NOT_CLOSED',
    );
    requireThat(isDeliveredIssue(issue), 'UPSTREAM_NOT_DELIVERED');
  };
  await verifyClosed();
  const before = await reader.blocking(upstream),
    seen = new Set(),
    targets = [];
  for (const edge of before) {
    requireThat(
      typeof edge.node_id === 'string' && !seen.has(edge.node_id) && !edge.pull_request,
      'INVALID_FANOUT_EDGE',
    );
    seen.add(edge.node_id);
    const target = await approvedTarget(edge.node_id, edge);
    if (!target) continue;
    requireThat(
      edge.number === target.number &&
        edge.url ===
          `https://api.github.com/repos/${target.repository}/issues/${target.number}`,
      'FANOUT_IDENTITY_CHANGED',
    );
    const reverse = await reader.blockedBy(target);
    requireThat(
      reverse.some(
        (item) =>
          item.node_id === upstream.id &&
          item.url ===
            'https://api.github.com/repos/' +
              `${upstream.repository}/issues/${upstream.number}`,
      ),
      'FANOUT_EDGE_CHANGED',
    );
    targets.push(target);
  }
  const results = [];
  for (const target of targets) {
    try {
      await verifyClosed();
    } catch (error) {
      if (results.length === 0) throw error;
      results.push({
        issueId: target.id,
        result: { status: 'denied', code: 'FANOUT_AUTHORITY_CHANGED' },
      });
      break;
    }
    let result;
    try {
      result = await wake(target);
    } catch {
      result = { status: 'pending', code: 'FANOUT_EFFECT_UNKNOWN' };
    }
    results.push({ issueId: target.id, result });
    if (!['scheduled', 'skipped'].includes(result.status)) break;
  }
  return results;
}
