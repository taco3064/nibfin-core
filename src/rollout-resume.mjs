import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { repoPath } from './github-read.mjs';
import { isId, requireThat } from './identity.mjs';
import { resolveSharedContinuation } from './issue-wake.mjs';
import { loadRelayHost } from './relay-host.mjs';
import { safeRelayCode } from './notification-relay.mjs';
import { sharedDispatchWorkflow } from './shared-runner.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';

// Run once at rollout completion. GitHub owns queueing and concurrency;
// each continuation enters normal Core admission and reuses completed work.
export async function resumeRolloutWork({ reader, configuration, inspect, journal,
  dispatch, completed = [], onDispatched = async () => {} }) {
  if ((await journal.control()).paused)
    return { status: 'paused', results: [] };
  const actor = await reader.get('/user');
  requireThat(actor.id === configuration.memberId && actor.type === 'User',
    'RELAY_CONTROLLER_CHANGED');
  const results = [];
  let failed = false;
  const pending = (issue, stage, error) => {
    failed = true;
    results.push({ ...issue, status: 'pending', stage, code: safeRelayCode(error),
      ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}) });
  };
  for (const origin of configuration.origins) {
    const root = repoPath(origin.repository);
    let issues;
    try {
      issues = await reader.list(`${root}/issues?state=open&labels=scope&` +
        `assignee=${encodeURIComponent(actor.login)}`);
    } catch (error) {
      pending({ repository: origin.repository }, 'list-issues', error);
      continue;
    }
    for (const item of issues) {
      if (item.pull_request) continue;
      const issue = { repository: origin.repository,
        repositoryId: origin.repositoryId, number: item.number, id: item.node_id };
      if (completed.some(done => done.repositoryId === issue.repositoryId &&
        done.id === issue.id)) continue;
      await inspect();
      let destination;
      try {
        destination = await continuationDestination(reader, configuration, issue, actor);
      } catch (error) {
        pending(issue, 'read-issue', error);
        continue;
      }
      if (!destination) continue;
      if ((await journal.control()).paused)
        return { status: 'paused', results };
      await inspect();
      try {
        const run = await dispatch(destination, {
          repository_id: String(issue.repositoryId), issue_number: String(issue.number),
          issue_id: issue.id, stage: 'continue',
        });
        const dispatched = { repository: issue.repository,
          repositoryId: issue.repositoryId, id: issue.id, number: issue.number, ...run };
        await onDispatched(dispatched);
        results.push(dispatched);
      } catch (error) { pending(issue, 'dispatch', error); }
    }
  }
  return { status: failed ? 'pending' : 'dispatched', results };
}

async function continuationDestination(reader, configuration, issue, actor) {
  const live = await reader.issue(issue);
  const root = repoPath(issue.repository);
  requireThat(live.node_id === issue.id && live.number === issue.number &&
    live.url === `https://api.github.com${root}/issues/${issue.number}`,
  'REPOSITORY_ISSUE_IDENTITY_CHANGED');
  if (live.labels.some(label => label.name === 'pause')) return null;
  try { await resolveSharedContinuation(reader, issue, live, actor); }
  catch (error) {
    if (['WAKE_TARGET_NOT_READY', 'INACTIVE_WAKE_TARGET'].includes(error.code))
      return null;
    throw error;
  }
  return sharedDispatchWorkflow(reader, configuration.runner);
}

export async function resumeInstalledWork(completed = []) {
  const context = await loadRelayHost({ currentAdoption: true });
  const control = async () => {
    const file = await lstat(join(context.journal.root, 'control.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    return file ? context.journal.control() : { paused: false };
  };
  return resumeRolloutWork({ ...context, completed, journal: { control },
    onDispatched: async result => console.log(JSON.stringify({ dispatched: result })),
    dispatch: async (destination, inputs) => {
      const response = await fetch('https://api.github.com' +
        `${repoPath(destination.repository)}/actions/workflows/` +
        `${destination.id}/dispatches`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${context.token}`,
          Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10' },
        body: JSON.stringify({ ref: destination.ref, inputs }),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        requireThat(false, 'ROLLOUT_CONTINUATION_DISPATCH_UNKNOWN');
      }
      const run = await response.json();
      requireThat(isId(run.workflow_run_id) && run.html_url ===
        `https://github.com/${destination.repository}/actions/runs/` +
        run.workflow_run_id, 'ROLLOUT_CONTINUATION_DISPATCH_UNKNOWN');
      return { runId: run.workflow_run_id, url: run.html_url };
    } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    requireThat(Array.isArray(input.completed), 'INVALID_ROLLOUT_RESUME_INPUT');
    const result = await withManagedAdmission(() => resumeInstalledWork(input.completed),
      { pool: true });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: 'pending', code: safeRelayCode(error) }));
    process.exitCode = 1;
  }
}
