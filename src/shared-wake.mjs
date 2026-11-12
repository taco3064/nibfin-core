import { readFile } from 'node:fs/promises';
import { isId, requireThat } from './identity.mjs';
import { pauseEvent } from './pause.mjs';

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
    issue: { number: issue.number, node_id: issue.node_id },
    repository: { id: repository.id, full_name: repository.full_name },
    ...(label ? { label: { name: label.name } } : {}),
  };
  if (pauseEvent(original)) {
    const { sender } = original;
    event.sender = { id: sender?.id, login: sender?.login, type: sender?.type };
    Object.assign(event.issue, {
      state: issue.state,
      updated_at: issue.updated_at,
      labels: issue.labels?.filter(({ name }) => ['pause', 'delivered'].includes(name))
        .map(({ name }) => ({ name })),
      assignees: issue.assignees?.map(({ id }) => ({ id })),
    });
  }
  const endpoint = 'https://api.github.com/repos/taco3064/nibfin-core/' +
    'actions/workflows/shared-runner.yml/dispatches';
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
    body: JSON.stringify({ ref: 'main', inputs: {
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
    result.html_url === 'https://github.com/taco3064/nibfin-core/actions/runs/' +
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
