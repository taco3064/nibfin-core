import { readFile } from 'node:fs/promises';
import { GitHubReader, repoPath } from './github-read.mjs';
import {
  readProtectedApproval,
  readMemberPermission,
} from './github-approval.mjs';
import {
  nativeEdgeIssue, repositoryIssuePin, readRepositoryPauseAuthority,
} from './repository-admission.mjs';
import { selectAssignee } from './selection.mjs';
import { isDeliveredIssue } from './dependencies.mjs';
import { observeWake, WakeDispatcher, fanout } from './wakeup.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource } from './caller-source.mjs';
import { sharedDispatchWorkflow } from './shared-runner.mjs';
import { pauseEvent } from './pause.mjs';
import { reconcilePause } from './pause-repair.mjs';

// Hosted preflight only. Event fields locate resources; adopted source pins,
// current native approval and the dispatch credential supply authority.
export async function observeIssueEvent(reader, adoption, event, invocation) {
  const pin = adoption?.eventWorkflow,
    root = repoPath(invocation.repository);
  requireThat(
    adoption?.schemaVersion === 1 &&
      isSha(adoption.coreCommit) &&
      adoption.coreCommit === invocation.coreCommit &&
      Array.isArray(adoption.issues) &&
      invocation.eventName === 'issues' &&
      invocation.attempt === 1 &&
      isId(invocation.runId) &&
      isId(pin?.id),
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
      (event.action !== 'labeled' ||
        ['scope', 'pause'].includes(event.label?.name)) &&
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
  const branch = await reader.get(
    `${root}/branches/${encodeURIComponent(repository.default_branch)}`,
  );
  const run = await reader.get(`${root}/actions/runs/${invocation.runId}`);
  requireThat(
    (adoption.repository?.approvalPin?.kind === 'repository-admission-v1' ||
      branch.protected === true) &&
      isSha(branch.commit?.sha) &&
      run.id === invocation.runId &&
      run.run_attempt === 1 &&
      run.event === 'issues' &&
      (run.status === 'in_progress' ||
        (invocation.forwarded && run.status === 'completed' &&
          run.conclusion === 'success')) &&
      run.workflow_id === pin.id &&
      run.path === pin.path &&
      run.head_branch === repository.default_branch &&
      run.repository?.id === repository.id &&
      run.head_repository?.id === repository.id &&
      run.actor?.id === run.triggering_actor?.id &&
      isId(run.actor?.id) &&
      Array.isArray(run.referenced_workflows) &&
      run.referenced_workflows.length === 1 &&
      run.referenced_workflows[0].path ===
        `taco3064/nibfin-core/.github/workflows/issue.yml@${adoption.coreCommit}` &&
      run.referenced_workflows[0].sha === adoption.coreCommit,
    'UNTRUSTED_ISSUE_EVENT_RUN',
  );
  const recipe = { kind: 'issue', coreCommit: adoption.coreCommit };
  if (pauseEvent(event)) {
    requireThat(isId(event.sender?.id) && event.sender.id === run.actor.id &&
      ['User', 'Bot'].includes(event.sender.type) &&
      event.sender.login === run.actor.login, 'PAUSE_EVENT_ACTOR_CHANGED');
  }
  await readCallerSource(reader, invocation.repository, pin, run.head_sha, recipe);
  await readCallerSource(reader, invocation.repository, pin, branch.commit.sha, recipe);
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
  return issue;
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

export function readWakeApproval(reader, pin, event) {
  if (pauseEvent(event) && pin.kind === 'repository-admission-v1')
    return readRepositoryPauseAuthority(reader, pin);
  return readProtectedApproval(reader, pin);
}

export async function resolveIssueWake(reader, adoption, event, invocation) {
  const upstream = await observeIssueEvent(reader, adoption, event, invocation);
  const live = await reader.issue(upstream);
  if (event.action === 'closed')
    requireThat(isDeliveredIssue(live), 'UPSTREAM_NOT_DELIVERED');
  const config = adoptedWake(adoption, upstream);
  const approval = await readWakeApproval(reader, config.approvalPin, event);
  requireThat(
    digest(approval.record.issue) === digest(upstream) &&
      approval.record.operations.includes('wake'),
    'EVENT_WAKE_NOT_APPROVED',
  );
  let route;
  if (pauseEvent(event)) {
    // Repair uses the adopted publisher's existing event Runner. Assignment and
    // ordinary wake eligibility cannot prevent negative-state reconciliation.
    requireThat(isId(config.actorId) &&
      config.actorId === approval.record.roles.publisher,
    'PAUSE_REPAIR_ROUTE_NOT_APPROVED');
    route = { userId: config.actorId };
  } else if (event.action === 'closed') {
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
    route = (await observeWake(reader, { ...config, shared: invocation.shared })).route;
  }
  return {
    status: 'resolved',
    issue_number: String(upstream.number),
    member_id: String(route.userId),
    stageAdmitted: false,
  };
}

// Hosted invocation has read capabilities only; it never journals or dispatches.
export async function runIssueWake(env = process.env) {
  requireThat(
    typeof env.NIBFIN_WAKE_ADOPTION === 'string' &&
      env.NIBFIN_WAKE_ADOPTION.length <= 262144 &&
      typeof env.NIBFIN_WAKE_TOKEN === 'string' &&
      env.NIBFIN_WAKE_TOKEN.trim() &&
      typeof env.GITHUB_EVENT_PATH === 'string',
    'WAKE_CONFIGURATION_REQUIRED',
  );
  const bytes = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
  requireThat(Buffer.byteLength(bytes) <= 1048576, 'WAKE_EVENT_TOO_LARGE');
  return resolveIssueWake(
    new GitHubReader(env.NIBFIN_WAKE_TOKEN),
    JSON.parse(env.NIBFIN_WAKE_ADOPTION),
    JSON.parse(bytes),
    {
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      runId: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      coreCommit: env.NIBFIN_CORE_COMMIT,
      shared: env.NIBFIN_SHARED_RUNNER_POOL === 'true',
    },
  ).catch((error) => {
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
    if (pauseEvent(event)) {
      const config = adoptedWake(adoption, upstream, peerRepositories);
      const pause = await reconcilePause({
        reader, issue: upstream, token, journal: pauseJournal, fetcher, event,
        authorize: async () => {
          await inspect();
          await observeIssueEvent(reader, adoption, event, invocation);
          const approval = await readWakeApproval(reader, config.approvalPin, event);
          const actor = await reader.get('/user');
          requireThat(digest(approval.record.issue) === digest(upstream) &&
            approval.record.operations.includes('wake') &&
            actor.type === 'User' && actor.id === config.actorId &&
            actor.id === approval.record.roles.publisher,
          'PAUSE_REPAIR_NOT_APPROVED');
          await readMemberPermission(reader, upstream.repository, actor);
          return { approvalHash: approval.approvalHash, actorId: actor.id };
        },
      });
      if (pause.status !== 'clear')
        return { status: pause.status === 'paused' ? 'skipped' : 'pending',
          code: pause.code ?? 'ISSUE_PAUSED', stageAdmitted: false };
    }
    const wake = async (issue) => {
      const config = adoptedWake(adoption, issue, peerRepositories);
      const pauseProofs = await new OperationJournal(stateRoot, issue).pauseEffects();
      try {
        await observeWake(reader, {
          ...config, shared: Boolean(sharedRunner), pauseProofs,
        });
      } catch (error) {
        if (
          [
            'WAKE_TARGET_NOT_READY',
            'INACTIVE_WAKE_TARGET',
            'WAKE_ENTRY_NOT_APPROVED',
          ].includes(error.code)
        ) {
          return { status: 'skipped', code: error.code };
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
            ...config, shared: Boolean(sharedRunner), pauseProofs,
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
    return { status: error.code === 'PAUSE_NOT_PROVEN_CLEAR' ? 'pending' : 'denied',
      code: error.code ?? 'WAKE_PLAN_REFUSED' };
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
