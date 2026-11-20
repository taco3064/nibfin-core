import { repoPath } from './github-read.mjs';
import { isId } from './identity.mjs';
import { networkGitHubRead } from './github-read-cause.mjs';
import { projectRolloutResult } from './core-rollout-result.mjs';

class WorkflowDispatchFailure extends Error {
  constructor(githubApi) {
    super('Native workflow dispatch was not confirmed');
    this.result = projectRolloutResult({ status: 'pending',
      code: 'GITHUB_API_RETRY_PENDING', githubApi });
  }
}

export function workflowDispatchFailure(error) {
  return error instanceof WorkflowDispatchFailure ? error.result : null;
}

// GitHub returns the dispatched run's native identity in API 2026-03-10.
// An unknown response is not permission to blindly repeat the write.
export async function dispatchNativeWorkflow(destination, inputs, token,
  fetcher = fetch) {
  let response;
  try {
    response = await fetcher('https://api.github.com' +
      `${repoPath(destination.repository)}/actions/workflows/` +
      `${destination.id}/dispatches`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10' },
      body: JSON.stringify({ ref: destination.ref, inputs }),
    });
  } catch (error) {
    throw new WorkflowDispatchFailure({ kind: networkGitHubRead(error) ||
      error instanceof TypeError ? 'network' : 'invalid-response' });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new WorkflowDispatchFailure(response.status >= 400 ?
      { kind: 'http', httpStatus: response.status } : { kind: 'invalid-response' });
  }
  let run;
  try { run = await response.json(); }
  catch { throw new WorkflowDispatchFailure({ kind: 'invalid-response' }); }
  if (!isId(run?.workflow_run_id) || run.html_url !==
    `https://github.com/${destination.repository}/actions/runs/${run.workflow_run_id}`)
    throw new WorkflowDispatchFailure({ kind: 'invalid-response' });
  return { runId: run.workflow_run_id, url: run.html_url };
}

export async function rerunNativeWorkflow(repository, id, token, fetcher = fetch) {
  let response;
  try {
    response = await fetcher('https://api.github.com' +
      `${repoPath(repository)}/actions/runs/${id}/rerun`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10' },
    });
  } catch (error) {
    throw new WorkflowDispatchFailure({ kind: networkGitHubRead(error) ||
      error instanceof TypeError ? 'network' : 'invalid-response' });
  }
  await response.body?.cancel().catch(() => {});
  if (response.status !== 201)
    throw new WorkflowDispatchFailure(response.status >= 400 ?
      { kind: 'http', httpStatus: response.status } : { kind: 'invalid-response' });
}
