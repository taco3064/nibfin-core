import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubReader, repoPath } from './github-read.mjs';
import { readPinnedFile } from './github-approval.mjs';
import { observeWake, WakeDispatcher, fanout } from './wakeup.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource } from './caller-source.mjs';

// Hosted preflight only. Event fields locate resources; adopted source pins,
// current native approval and the dispatch credential supply authority.
export async function observeIssueEvent(reader, adoption, event, invocation) {
  const pin = adoption?.eventWorkflow, root = repoPath(invocation.repository);
  requireThat(adoption?.schemaVersion === 1 && isSha(adoption.coreCommit) &&
    adoption.coreCommit === invocation.coreCommit && Array.isArray(adoption.issues) &&
    invocation.eventName === 'issues' && invocation.attempt === 1 && isId(invocation.runId) &&
    isId(pin?.id) && isSha(pin.commit) && isSha(pin.blob), 'INVALID_ISSUE_WAKE');
  requireThat(['labeled', 'assigned', 'reopened', 'closed'].includes(event?.action) &&
    (event.action !== 'labeled' || event.label?.name === 'scope') &&
    isId(event.issue?.number) && typeof event.issue.node_id === 'string' &&
    !event.issue.pull_request, 'UNSUPPORTED_ISSUE_EVENT');
  const repository = await reader.repository(invocation.repository);
  requireThat(repository.private === false && repository.full_name === invocation.repository &&
    repository.id === event.repository?.id && event.repository.full_name === repository.full_name,
    'ISSUE_EVENT_REPOSITORY_CHANGED');
  const branch = await reader.get(`${root}/branches/${encodeURIComponent(repository.default_branch)}`);
  const run = await reader.get(`${root}/actions/runs/${invocation.runId}`);
  requireThat(branch.protected === true && branch.commit?.sha === run.head_sha &&
    run.id === invocation.runId && run.run_attempt === 1 && run.event === 'issues' &&
    run.status === 'in_progress' && run.workflow_id === pin.id && run.path === pin.path &&
    run.head_branch === repository.default_branch &&
    run.repository?.id === repository.id && run.head_repository?.id === repository.id &&
    run.actor?.id === run.triggering_actor?.id && isId(run.actor?.id) &&
    Array.isArray(run.referenced_workflows) && run.referenced_workflows.length === 1 &&
    run.referenced_workflows[0].path ===
      `taco3064/nibfin-core/.github/workflows/issue.yml@${adoption.coreCommit}` &&
    run.referenced_workflows[0].sha === adoption.coreCommit, 'UNTRUSTED_ISSUE_EVENT_RUN');
  await readPinnedFile(reader, invocation.repository, pin.path, pin.commit, pin.blob);
  await readCallerSource(reader, invocation.repository, pin, run.head_sha);
  const workflow = await reader.get(`${root}/actions/workflows/${pin.id}`);
  requireThat(workflow.state === 'active' && workflow.path === pin.path, 'ISSUE_WORKFLOW_CHANGED');
  const issue = { repository: invocation.repository, repositoryId: repository.id,
    id: event.issue.node_id, number: event.issue.number };
  const live = await reader.issue(issue);
  requireThat(live.node_id === issue.id && live.number === issue.number && !live.pull_request &&
    live.url === `https://api.github.com${root}/issues/${issue.number}`, 'ISSUE_EVENT_IDENTITY_CHANGED');
  requireThat(digest(await reader.get(`${root}/actions/runs/${invocation.runId}`)) === digest(run) &&
    digest(await reader.get(`${root}/branches/${encodeURIComponent(repository.default_branch)}`)) === digest(branch),
    'ISSUE_EVENT_SOURCE_CHANGED');
  return issue;
}

export async function runIssueWake(env = process.env) {
  requireThat(typeof env.NIBFIN_WAKE_ADOPTION === 'string' && env.NIBFIN_WAKE_ADOPTION.length <= 262144 &&
    typeof env.NIBFIN_WAKE_TOKEN === 'string' && env.NIBFIN_WAKE_TOKEN.trim() &&
    typeof env.GITHUB_EVENT_PATH === 'string', 'WAKE_CONFIGURATION_REQUIRED');
  const bytes = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
  requireThat(Buffer.byteLength(bytes) <= 1048576, 'WAKE_EVENT_TOO_LARGE');
  const event = JSON.parse(bytes), adoption = JSON.parse(env.NIBFIN_WAKE_ADOPTION);
  const invocation = { repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), coreCommit: env.NIBFIN_CORE_COMMIT };
  const reader = new GitHubReader(env.NIBFIN_WAKE_TOKEN);
  const upstream = await observeIssueEvent(reader, adoption, event, invocation);
  const root = await mkdtemp(join(tmpdir(), 'nibfin-wake-'));
  const selected = id => {
    const matches = adoption.issues.filter(item => item.approvalPin?.issueId === id);
    requireThat(matches.length <= 1, 'AMBIGUOUS_WAKE_ADOPTION');
    return matches[0];
  };
  const wake = async issue => {
    const config = selected(issue.id);
    requireThat(config && config.approvalPin.source?.commit === adoption.coreCommit &&
      config.approvalPin.source.repository === 'taco3064/nibfin-core', 'WAKE_ISSUE_NOT_ADOPTED');
    return new WakeDispatcher({ token: env.NIBFIN_WAKE_TOKEN,
      journal: new OperationJournal(root, issue), observe: async current => {
        await observeIssueEvent(current, adoption, event, invocation);
        const result = await observeWake(current, config);
        requireThat(digest(result.issue) === digest(issue), 'WAKE_TARGET_CHANGED');
        return result;
      } }).dispatch();
  };
  if (event.action !== 'closed') return wake(upstream);
  return fanoutOutcome(await fanout(reader, upstream, {
    approvedTarget: async id => {
      const config = selected(id);
      if (!config) return null;
      return (await observeWake(reader, config)).issue;
    }, wake,
  }));
}

export function fanoutOutcome(results) {
  const status = results.some(item => item.result.status === 'pending') ? 'pending' :
    results.some(item => item.result.status !== 'scheduled') ? 'denied' : 'scheduled';
  return { status, code: status === 'pending' ? 'FANOUT_EFFECT_UNKNOWN' :
    status === 'denied' ? 'FANOUT_DENIED' : 'FANOUT_READ_BACK', results };
}
