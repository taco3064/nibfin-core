import { readFile } from 'node:fs/promises';
import { gitBlob, isId, requireThat } from './identity.mjs';
import { GitHubReader, repoPath } from './github-read.mjs';
import { readPinnedFile } from './github-approval.mjs';
import { sharedDestinationVariable, sharedWorkflowPath } from './shared-runner.mjs';

async function sharedWakeDestination(env, fetcher) {
  const configured = env[sharedDestinationVariable];
  // Keep existing official installations working until they publish a destination.
  if (!configured) return { repository: 'taco3064/nibfin-core', ref: 'main' };
  let destination;
  try { destination = JSON.parse(configured); }
  catch { requireThat(false, 'INVALID_SHARED_WAKE_DESTINATION'); }
  requireThat(isId(destination?.repositoryId), 'INVALID_SHARED_WAKE_DESTINATION');
  const repository = destination.repository;
  repoPath(repository);
  const reader = new GitHubReader(env.NIBFIN_WAKE_TOKEN, fetcher);
  const observed = await reader.repository(repository);
  requireThat(observed.id === destination.repositoryId &&
    observed.full_name === repository && observed.private === false &&
    observed.archived === false && observed.disabled === false &&
    typeof observed.default_branch === 'string' && observed.default_branch,
    'SHARED_WAKE_DESTINATION_CHANGED');
  const ref = observed.default_branch;
  const root = repoPath(repository);
  const path = sharedWorkflowPath;
  const workflow = path.split('/').at(-1);
  const [branch, registered, expected] = await Promise.all([
    reader.get(`${root}/branches/${encodeURIComponent(ref)}`),
    reader.get(`${root}/actions/workflows/${workflow}`),
    readFile(new URL(`../${path}`, import.meta.url)),
  ]);
  requireThat(isId(registered?.id) && registered.path === path &&
    registered.state === 'active', 'SHARED_DISPATCH_WORKFLOW_UNAVAILABLE');
  await readPinnedFile(reader, repository, path, branch?.commit?.sha, gitBlob(expected));
  return { repository, ref };
}

export async function forwardSharedWake(resolved, env, fetcher = fetch) {
  if (resolved.status !== 'resolved') return;
  const original = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const { action, issue, repository, label } = original;
  const runId = Number(env.GITHUB_RUN_ID);
  requireThat(isId(runId) && env.GITHUB_RUN_ATTEMPT === '1' &&
    issue.number === Number(resolved.issue_number) && isId(repository.id),
    'INVALID_SHARED_WAKE_ORIGIN');
  const event = {
    action,
    issue: { number: issue.number, node_id: issue.node_id,
      state: issue.state, updated_at: issue.updated_at,
      assignees: issue.assignees?.map(({ id, login, type }) => ({ id, login, type })),
      labels: issue.labels?.filter(item => ['pause', 'delivered'].includes(item.name))
        .map(({ name }) => ({ name })),
    },
    sender: original.sender && {
      id: original.sender.id, login: original.sender.login, type: original.sender.type,
    },
    repository: { id: repository.id, full_name: repository.full_name },
    ...(label ? { label: { name: label.name } } : {}),
  };
  const { repository: executionRepo, ref } = await sharedWakeDestination(env, fetcher);
  const workflow = sharedWorkflowPath.split('/').at(-1);
  const endpoint = `https://api.github.com${repoPath(executionRepo)}/actions/workflows/` +
    `${workflow}/dispatches`;
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${env.NIBFIN_WAKE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ ref, inputs: {
      repository_id: String(repository.id),
      issue_number: resolved.issue_number,
      issue_id: issue.node_id,
      stage: 'wake',
      wake_event: JSON.stringify({ event, runId }),
    } }),
  });
  requireThat(response.status === 200, `SHARED_WAKE_HTTP_${response.status}`);
  const result = await response.json();
  requireThat(isId(result.workflow_run_id) &&
    result.html_url === `https://github.com/${executionRepo}/actions/runs/` +
      result.workflow_run_id, 'SHARED_WAKE_DISPATCH_UNKNOWN');
  console.log(`Shared wake run ${result.workflow_run_id}`);
}

export function readForwardedWake(bytes, issue) {
  const { inputs } = JSON.parse(bytes);
  requireThat(inputs?.stage === 'wake' && inputs.issue_id === issue.id &&
    Number(inputs.repository_id) === issue.repositoryId &&
    Number(inputs.issue_number) === issue.number &&
    typeof inputs.wake_event === 'string' && inputs.wake_event.length <= 4096,
    'INVALID_SHARED_WAKE');
  const forwarded = JSON.parse(inputs.wake_event);
  requireThat(isId(forwarded.runId) &&
    forwarded.event?.issue?.number === issue.number &&
    forwarded.event.issue.node_id === issue.id &&
    forwarded.event.repository?.id === issue.repositoryId &&
    forwarded.event.repository.full_name === issue.repository,
    'INVALID_SHARED_WAKE');
  return forwarded;
}
