import { pauseTrigger, reconcilePause } from './pause-controller.mjs';
import { readFile } from 'node:fs/promises';
import { retryGitHubObservation } from './observation-failure.mjs';
import { GitHubReader, repoPath } from './github-read.mjs';
import {
  readProtectedApproval,
  readMemberPermission,
} from './github-approval.mjs';
import { nativeEdgeIssue, repositoryIssuePin } from './repository-admission.mjs';
import { selectAssignee } from './selection.mjs';
import { isDeliveredIssue } from './dependencies.mjs';
import { observeWake, WakeDispatcher, fanout } from './wakeup.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource } from './caller-source.mjs';
import { sharedDispatchWorkflow } from './shared-runner.mjs';

const issueCallerPath = '.github/workflows/nibfin-issue.yml';
const reusableIssuePath = 'taco3064/nibfin-core/.github/workflows/issue.yml';

// Event fields locate resources. The GitHub run establishes the event's source.
export async function observeIssueEvent(reader, adoption, event, invocation) {
  return (await readIssueEvent(reader, adoption, event, invocation)).issue;
}

async function readIssueEvent(reader, adoption, event, invocation) {
  const root = repoPath(invocation.repository);
  const hostedRelay = invocation.shared && !adoption;
  requireThat(
    isSha(invocation.coreCommit) &&
      (hostedRelay || (adoption?.schemaVersion === 1 &&
        adoption.coreCommit === invocation.coreCommit &&
        Array.isArray(adoption.issues) && isId(adoption.eventWorkflow?.id))) &&
      invocation.eventName === 'issues' &&
      invocation.attempt === 1 &&
      isId(invocation.runId),
    'INVALID_ISSUE_WAKE',
  );
  requireThat(
    [
      'opened',
      'edited',
      'labeled',
      'unlabeled',
      'assigned',
      'unassigned',
      'reopened',
      'closed',
    ].includes(event?.action) &&
      (event.action !== 'labeled' || ['scope', 'pause'].includes(event.label?.name)) &&
      isId(event.issue?.number) &&
      typeof event.issue.node_id === 'string' &&
      !event.issue.pull_request,
    'UNSUPPORTED_ISSUE_EVENT',
  );
  const repository = await reader.repository(invocation.repository);
  requireThat(
    repository.private === false &&
      repository.full_name === invocation.repository &&
      repository.id === event.repository?.id &&
      event.repository.full_name === repository.full_name,
    'ISSUE_EVENT_REPOSITORY_CHANGED',
  );
  const run = await reader.get(`${root}/actions/runs/${invocation.runId}`);
  const pin = hostedRelay ? { id: run.workflow_id, path: issueCallerPath }
    : adoption.eventWorkflow;
  const reference = run.referenced_workflows?.[0];
  const eventCommit = invocation.forwarded ? reference?.sha : invocation.coreCommit;
  requireThat(
    run.id === invocation.runId &&
      run.run_attempt === 1 &&
      run.event === 'issues' &&
      (run.status === 'in_progress' ||
        (invocation.forwarded && run.status === 'completed' &&
          run.conclusion === 'success')) &&
      isId(pin.id) && run.workflow_id === pin.id &&
      run.path === pin.path &&
      run.head_branch === repository.default_branch &&
      run.repository?.id === repository.id &&
      run.head_repository?.id === repository.id &&
      run.actor?.id === run.triggering_actor?.id &&
      isId(run.actor?.id) &&
      Array.isArray(run.referenced_workflows) &&
      run.referenced_workflows.length === 1 &&
      isSha(eventCommit) && reference?.path === `${reusableIssuePath}@${eventCommit}` &&
      reference.sha === eventCommit,
    'UNTRUSTED_ISSUE_EVENT_RUN',
  );
  if (pauseTrigger(event)) requireThat(event.sender?.type === 'User' &&
    event.sender.id === run.actor.id && event.sender.login === run.actor.login,
  'UNTRUSTED_PAUSE_ACTOR');
  await readCallerSource(reader, invocation.repository, pin, run.head_sha, {
    kind: 'issue', coreCommit: eventCommit,
  });
  if (!hostedRelay) {
    const branch = await reader.get(
      `${root}/branches/${encodeURIComponent(repository.default_branch)}`,
    );
    requireThat(adoption.repository?.approvalPin?.kind === 'repository-admission-v1' ||
      branch.protected === true, 'UNTRUSTED_ISSUE_EVENT_RUN');
    await readCallerSource(reader, invocation.repository, pin, branch.commit?.sha, {
      kind: 'issue', coreCommit: invocation.coreCommit,
    });
  }
  const workflow = await reader.get(`${root}/actions/workflows/${pin.id}`);
  requireThat(
    workflow.state === 'active' && workflow.path === pin.path,
    'ISSUE_WORKFLOW_CHANGED',
  );
  const issue = {
    repository: invocation.repository,
    repositoryId: repository.id,
    id: event.issue.node_id,
    number: event.issue.number,
  };
  const live = await reader.issue(issue);
  requireThat(
    live.node_id === issue.id &&
      live.number === issue.number &&
      !live.pull_request &&
      live.url === `https://api.github.com${root}/issues/${issue.number}`,
    'ISSUE_EVENT_IDENTITY_CHANGED',
  );
  return { issue, live };
}

export function adoptedWake(adoption, identity, peers = []) {
  const id = typeof identity === 'string' ? identity : identity.id;
  const matches = adoption.issues.filter((item) => item.approvalPin?.issueId === id);
  requireThat(matches.length <= 1, 'AMBIGUOUS_WAKE_ADOPTION');
  let selected = matches[0];
  const repositories = [adoption.repository, ...peers].filter(Boolean);
  const config = repositories.find(item =>
    item.approvalPin.repository === identity?.repository &&
    item.approvalPin.repositoryId === identity?.repositoryId);
  if (!selected && config) {
    selected = {
      ...config,
      approvalPin: repositoryIssuePin(config.approvalPin, identity),
    };
  }
  requireThat(selected, 'WAKE_ISSUE_NOT_ADOPTED');
  requireThat(
    selected.approvalPin.source?.commit === adoption.coreCommit &&
      selected.approvalPin.source.repository === 'taco3064/nibfin-core',
    'WAKE_SOURCE_CHANGED',
  );
  return selected;
}

export async function resolveIssueWake(reader, adoption, event, invocation) {
  const upstream = await observeIssueEvent(reader, adoption, event, invocation);
  const live = await reader.issue(upstream);
  if (event.action === 'closed')
    requireThat(isDeliveredIssue(live), 'UPSTREAM_NOT_DELIVERED');
  const config = adoptedWake(adoption, upstream);
  const approval = await readProtectedApproval(reader, config.approvalPin);
  requireThat(
    digest(approval.record.issue) === digest(upstream) &&
      approval.record.operations.includes('wake'),
    'EVENT_WAKE_NOT_APPROVED',
  );
  let route;
  if (event.action === 'closed' || pauseTrigger(event)) {
    route = await selectAssignee(live, async (user) => {
      if (user.id !== approval.record.roles.writer) return false;
      if (config.approvalPin.kind !== 'repository-admission-v1')
        await readMemberPermission(reader, upstream.repository, {
          ...user, type: 'User',
        });
      return true;
    });
    requireThat(route, 'WAKE_TARGET_NOT_READY');
  } else {
    route = (await observeWake(reader, {
      ...config, shared: invocation.shared, routingOnly: true,
    })).route;
  }
  return {
    status: 'resolved',
    issue_number: String(upstream.number),
    member_id: String(route.userId),
    stageAdmitted: false,
  };
}

export async function resolveSharedIssueWake(reader, event, invocation) {
  const { issue, live } = await readIssueEvent(reader, null, event, invocation);
  const actor = await reader.get('/user');
  const scope = live.labels?.some(label => label.name === 'scope');
  requireThat(scope && actor.type === 'User', 'WAKE_TARGET_NOT_READY');
  if (event.action === 'closed') {
    requireThat(isDeliveredIssue(live), 'UPSTREAM_NOT_DELIVERED');
  } else if (!pauseTrigger(event)) {
    requireThat(live.state === 'open' &&
      !live.labels.some(label => label.name === 'delivered'), 'INACTIVE_WAKE_TARGET');
    const prerequisites = await reader.blockedBy(issue);
    requireThat(prerequisites.every(isDeliveredIssue), 'WAKE_TARGET_NOT_READY');
  }
  const route = await selectAssignee(live, async user => user.id === actor.id);
  requireThat(route, 'WAKE_TARGET_NOT_READY');
  return {
    status: 'resolved', issue_number: String(issue.number),
    member_id: String(route.userId), stageAdmitted: false,
  };
}

// The hosted job routes locators. The installed Core admits and journals work.
export async function runIssueWake(env = process.env) {
  const shared = env.NIBFIN_SHARED_RUNNER_POOL === 'true';
  requireThat(
    (shared || (typeof env.NIBFIN_WAKE_ADOPTION === 'string' &&
      env.NIBFIN_WAKE_ADOPTION.length <= 262144)) &&
      typeof env.NIBFIN_WAKE_TOKEN === 'string' &&
      env.NIBFIN_WAKE_TOKEN.trim() &&
      typeof env.GITHUB_EVENT_PATH === 'string',
    'WAKE_CONFIGURATION_REQUIRED',
  );
  const bytes = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
  requireThat(Buffer.byteLength(bytes) <= 1048576, 'WAKE_EVENT_TOO_LARGE');
  const reader = new GitHubReader(env.NIBFIN_WAKE_TOKEN), event = JSON.parse(bytes);
  const invocation = {
    repository: env.GITHUB_REPOSITORY,
    eventName: env.GITHUB_EVENT_NAME,
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    coreCommit: env.NIBFIN_CORE_COMMIT,
    shared,
  };
  const result = retryGitHubObservation(() => shared
    ? resolveSharedIssueWake(reader, event, invocation)
    : resolveIssueWake(reader, JSON.parse(env.NIBFIN_WAKE_ADOPTION), event, invocation),
  { timeout: 90000 });
  return result.catch((error) => {
    const idle = ['WAKE_TARGET_NOT_READY', 'INACTIVE_WAKE_TARGET',
      'UPSTREAM_NOT_DELIVERED', 'UNSUPPORTED_ISSUE_EVENT'];
    if (idle.includes(error.code))
      return { status: 'skipped', code: error.code, stageAdmitted: false };
    throw error;
  });
}

// Only the fixed installed host supplies this persistent directory and token.
// Fresh event identity is excluded from the persisted target decision digest.
export async function dispatchIssueWake({
  reader,
  adoption,
  event,
  invocation,
  token,
  stateRoot,
  inspect,
  fetcher = fetch,
  peerRepositories = [],
  sharedRunner,
}) {
  let journalEntered = false;
  try {
    const upstream = await observeIssueEvent(reader, adoption, event, invocation);
    const pauseJournal = new OperationJournal(stateRoot, upstream);
    if (pauseTrigger(event)) {
      const config = adoptedWake(adoption, upstream);
      const approval = await readProtectedApproval(reader, config.approvalPin);
      requireThat(digest(approval.record.issue) === digest(upstream) &&
        approval.record.operations.includes('wake') &&
        approval.record.roles.publisher === config.actorId, 'EVENT_WAKE_NOT_APPROVED');
      journalEntered = true;
      const pause = await reconcilePause({ reader, issue: upstream, event,
        journal: pauseJournal, token, fetcher, actorId: config.actorId,
        inspect: async () => {
          await inspect();
          await observeIssueEvent(reader, adoption, event, invocation);
          const fresh = await readProtectedApproval(reader, config.approvalPin);
          requireThat(fresh.approvalHash === approval.approvalHash,
            'EVENT_AUTHORITY_CHANGED');
        },
      });
      if (pause.status !== 'clear') return {
        status: pause.status === 'paused' ? 'skipped' : 'pending', code: pause.code,
      };
    }
    const wake = async (issue) => {
      const config = adoptedWake(adoption, issue, peerRepositories);
      const evidence = await new OperationJournal(stateRoot, issue).pauseEvidence();
      requireThat(!evidence.pending, 'EXTERNAL_EFFECT_UNKNOWN');
      config.pauseDecisions = evidence.decisions;
      try {
        await observeWake(reader, { ...config, shared: Boolean(sharedRunner) });
      } catch (error) {
        if (
          [
            'WAKE_TARGET_NOT_READY',
            'INACTIVE_WAKE_TARGET',
            'WAKE_ENTRY_NOT_APPROVED',
            'ISSUE_PAUSED',
            'PAUSE_OBSERVATION_UNKNOWN',
          ].includes(error.code)
        ) {
          return { status: 'skipped', code: error.code,
            ...(error.pauseReason ? { pauseReason: error.pauseReason } : {}) };
        }
        throw error;
      }
      // Any journal entry may leave unresolved durable intent. After this point
      // an exception must retain the host fence, even without an observed POST.
      journalEntered = true;
      const result = await new WakeDispatcher({
        token,
        fetcher,
        journal: new OperationJournal(stateRoot, issue),
        observe: async (current) => {
          await inspect();
          await observeIssueEvent(current, adoption, event, invocation);
          const observed = await observeWake(current, {
            ...config, shared: Boolean(sharedRunner),
          });
          requireThat(observed.issue.id === issue.id &&
            observed.issue.repositoryId === issue.repositoryId, 'WAKE_TARGET_CHANGED');
          if (!sharedRunner) return observed;
          const workflow = await sharedDispatchWorkflow(current, sharedRunner);
          return { ...observed, workflow };
        },
      }).dispatch();
      return result.code === 'REPLAYED_OPERATION'
        ? { ...result, status: 'skipped' }
        : result;
    };
    if (event.action !== 'closed') return await wake(upstream);
    return fanoutOutcome(
      await fanout(reader, upstream, {
        approvedTarget: async (id, edge) => {
          const configs = adoption.issues.filter(
            (item) => item.approvalPin?.issueId === id,
          );
          requireThat(configs.length <= 1, 'AMBIGUOUS_WAKE_ADOPTION');
          if (configs.length === 0) {
            for (const config of [adoption.repository, ...peerRepositories]) {
              if (!config) continue;
              const { repository, repositoryId } = config.approvalPin;
              const target = nativeEdgeIssue(edge, { repository, repositoryId });
              if (target) return target;
            }
            return null;
          }
          return (await readProtectedApproval(reader, configs[0].approvalPin)).record
            .issue;
        },
        wake,
      }),
    );
  } catch (error) {
    if (journalEntered) throw error;
    // Positively no journal or external write was entered. A malformed or
    // revoked event/graph may be refused without stranding the whole host.
    return { status: 'denied', code: error.code ?? 'WAKE_PLAN_REFUSED' };
  }
}

export function fanoutOutcome(results) {
  const status = results.some((item) => item.result.status === 'pending')
    ? 'pending'
    : results.some((item) => !['scheduled', 'skipped'].includes(item.result.status))
      ? 'denied'
      : 'scheduled';
  return {
    status,
    code:
      status === 'pending'
        ? 'FANOUT_EFFECT_UNKNOWN'
        : status === 'denied'
          ? 'FANOUT_DENIED'
          : 'FANOUT_READ_BACK',
    results,
  };
}
