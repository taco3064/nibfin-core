import { readFile } from 'node:fs/promises';
import { GitHubReader, repoPath } from './github-read.mjs';
import {
  readPinnedFile,
  readProtectedApproval,
  readMemberPermission,
} from './github-approval.mjs';
import { selectAssignee } from './selection.mjs';
import { isDeliveredIssue } from './dependencies.mjs';
import { observeWake, WakeDispatcher, fanout } from './wakeup.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource, readCallerContinuity } from './caller-source.mjs';

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
      isId(pin?.id) &&
      isSha(pin.commit) &&
      isSha(pin.blob),
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
      (event.action !== 'labeled' || event.label?.name === 'scope') &&
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
    branch.protected === true &&
      isSha(branch.commit?.sha) &&
      run.id === invocation.runId &&
      run.run_attempt === 1 &&
      run.event === 'issues' &&
      run.status === 'in_progress' &&
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
  await readPinnedFile(reader, invocation.repository, pin.path, pin.commit, pin.blob);
  await readCallerSource(reader, invocation.repository, pin, run.head_sha, {
    kind: 'issue',
    coreCommit: adoption.coreCommit,
  });
  await readCallerContinuity(reader, invocation.repository, pin, branch.commit.sha);
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
  requireThat(
    digest(await reader.get(`${root}/actions/runs/${invocation.runId}`)) ===
      digest(run) &&
      digest(
        await reader.get(
          `${root}/branches/${encodeURIComponent(repository.default_branch)}`,
        ),
      ) === digest(branch),
    'ISSUE_EVENT_SOURCE_CHANGED',
  );
  return issue;
}

export function adoptedWake(adoption, id) {
  const matches = adoption.issues.filter((item) => item.approvalPin?.issueId === id);
  requireThat(matches.length === 1, 'WAKE_ISSUE_NOT_ADOPTED');
  const selected = matches[0];
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
  const config = adoptedWake(adoption, upstream.id);
  const approval = await readProtectedApproval(reader, config.approvalPin);
  requireThat(
    digest(approval.record.issue) === digest(upstream) &&
      approval.record.operations.includes('wake'),
    'EVENT_WAKE_NOT_APPROVED',
  );
  let route;
  if (event.action === 'closed') {
    route = await selectAssignee(live, async (user) => {
      if (user.id !== approval.record.roles.writer) return false;
      await readMemberPermission(reader, upstream.repository, { ...user, type: 'User' });
      return true;
    });
    requireThat(route, 'WAKE_TARGET_NOT_READY');
  } else {
    route = (await observeWake(reader, config)).route;
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
    },
  );
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
}) {
  let journalEntered = false;
  try {
    const upstream = await observeIssueEvent(reader, adoption, event, invocation);
    const wake = async (issue) => {
      const config = adoptedWake(adoption, issue.id);
      try {
        await observeWake(reader, config);
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
          const observed = await observeWake(current, config);
          requireThat(digest(observed.issue) === digest(issue), 'WAKE_TARGET_CHANGED');
          return observed;
        },
      }).dispatch();
      return result.code === 'REPLAYED_OPERATION'
        ? { ...result, status: 'skipped' }
        : result;
    };
    if (event.action !== 'closed') return await wake(upstream);
    return fanoutOutcome(
      await fanout(reader, upstream, {
        approvedTarget: async (id) => {
          const configs = adoption.issues.filter(
            (item) => item.approvalPin?.issueId === id,
          );
          requireThat(configs.length <= 1, 'AMBIGUOUS_WAKE_ADOPTION');
          if (configs.length === 0) return null;
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
