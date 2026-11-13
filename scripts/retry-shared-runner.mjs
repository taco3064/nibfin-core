import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { command } from '../src/process.mjs';
import { GitHubReader, repoPath } from '../src/github-read.mjs';
import { isId, requireThat } from '../src/identity.mjs';
import {
  githubReadWaiting, retryGitHubObservation,
} from '../src/observation-failure.mjs';
import { sharedWorkflowPath } from '../src/shared-runner.mjs';

const repository = 'taco3064/nibfin-core';
const maxAttempt = 3;
const maxDelay = 15 * 60 * 1000;

export function retryDelay(log, id, attempt) {
  const matches = [...log.matchAll(/(?:^|Z )(\{"schemaVersion":1,[^\r\n]+\})\r?$/gm)];
  if (matches.length !== 1) return null;
  let result;
  try { result = JSON.parse(matches[0][1]); }
  catch { return null; }
  const wait = result.retryAfterMs;
  return result.status === 'pending' && result.code === githubReadWaiting &&
    result.stage === 'continue' && result.retrySettled === true &&
    result.retryRun === id && result.retryAttempt === attempt &&
    Number.isSafeInteger(wait) && wait >= 0 && wait <= maxDelay
    ? Math.max(30000, wait) : null;
}

export async function retrySharedRunner(reader, event, { logs, rerun, wait }) {
  const run = event.workflow_run;
  const repo = event.repository;
  if (repo?.full_name !== repository || !isId(repo.id) || !isId(run?.id) ||
    !isId(run.run_attempt) || run.run_attempt >= maxAttempt ||
    run.head_repository?.id !== repo.id || run.path !== sharedWorkflowPath ||
    run.head_branch !== repo.default_branch || run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' || run.conclusion !== 'failure') return false;
  const root = repoPath(repository);
  const path = `${root}/actions/runs/${run.id}`;
  const stillFailed = async () => {
    const current = await retryGitHubObservation(() => reader.get(path),
      { timeout: 60000 });
    return current.id === run.id && current.run_attempt === run.run_attempt &&
      current.repository?.id === repo.id && current.head_repository?.id === repo.id &&
      current.status === 'completed' && current.conclusion === 'failure' &&
      current.path === sharedWorkflowPath && current.event === 'workflow_dispatch' &&
      current.actor?.id === run.actor?.id && current.head_branch === repo.default_branch;
  };
  if (!await stillFailed()) return false;
  const jobs = await retryGitHubObservation(() => reader.list(
    `${path}/attempts/${run.run_attempt}/jobs`, 'jobs'), { timeout: 60000 });
  const failed = jobs.filter(job => job.name === 'shared-stage' &&
    job.conclusion === 'failure' && job.status === 'completed' &&
    job.run_id === run.id && job.run_attempt === run.run_attempt && isId(job.id));
  if (failed.length !== 1) return false;
  const delay = retryDelay(await logs(failed[0].id), run.id, run.run_attempt);
  if (delay === null) return false;
  const actor = await retryGitHubObservation(() => reader.get('/user'),
    { timeout: 60000 });
  requireThat(isId(actor.id) && actor.id === run.actor?.id,
    'RETRY_DISPATCH_ACTOR_MISMATCH');
  await wait(delay);
  if (!await stillFailed()) return false;
  await rerun(run.id);
  return true;
}

async function main() {
  const token = process.env.GH_TOKEN;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = args => command('/usr/bin/gh', args, {
    cwd: '/', env: { PATH: '/usr/bin:/bin', GH_TOKEN: token, GH_PROMPT_DISABLED: '1' },
    timeout: 60000,
  });
  const retried = await retrySharedRunner(new GitHubReader(token), event, {
    logs: async id => (await gh(['run', 'view', '-R', repository,
      '--job', String(id), '--log'])).stdout.toString(),
    rerun: id => gh(['run', 'rerun', '-R', repository, String(id), '--failed']),
    wait: setTimeout,
  });
  console.log(retried
    ? 'Requested the next Nibfin attempt.' : 'No safe retry requested.');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch(error => {
    console.error(error.code === 'RETRY_DISPATCH_ACTOR_MISMATCH'
      ? error.code : 'NIBFIN_RETRY_OBSERVATION_OR_DISPATCH_FAILED');
    process.exitCode = 1;
  });
}
