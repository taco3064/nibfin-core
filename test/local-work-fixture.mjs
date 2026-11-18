import { coreRoot } from '../src/host-adoption.mjs';
import { providerHost } from './provider-fixture.mjs';

export const at = '2026-11-18T12:00:00Z';
export const subject = { id: 5, login: 'member', type: 'User' };
export const route = { repository: 'example/project', repositoryId: 2 };
export const identity = { ...route, number: 7, id: 'I_target' };
export const issue = { node_id: identity.id, number: 7, state: 'open',
  url: 'https://api.github.com/repos/example/project/issues/7',
  updated_at: at, labels: [{ name: 'scope' }], assignees: [subject] };
export function adopted() {
  const host = providerHost();
  host.installation.directory = coreRoot;
  host.sharedRunner.repositories = [1];
  return host;
}
export function fixture(count = 1) {
  const host = { uid: 90, stateRoot: '/never-read', routes: [route], errors: [],
    confirm: async () => {}, bindings: Array.from({ length: count }, (_, index) => ({
      hostId: 'local-controller-90', shared: true, routes: [route], expected: {
        repository: 'example/pool', repositoryId: 1, runnerId: 42 + index,
        runnerName: `runner-${index}`, memberId: 5, workflowId: 50,
        workflowPath: '.github/workflows/shared-runner.yml', jobName: 'shared-stage',
      },
    })) };
  const run = { id: 100, run_attempt: 1, repository: { id: 1, full_name: 'example/pool' },
    head_repository: { id: 1, full_name: 'example/pool' }, workflow_id: 50,
    path: '.github/workflows/shared-runner.yml', head_branch: 'main',
    head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null,
    actor: subject, triggering_actor: subject };
  const job = { id: 200, run_id: 100, run_attempt: 1, head_sha: run.head_sha,
    name: 'shared-stage', status: 'in_progress', conclusion: null,
    runner_id: 42, runner_name: 'runner-0', labels: ['self-hosted', 'nibfin-shared'],
    html_url: 'https://github.com/example/pool/actions/runs/100/job/200',
    started_at: at };
  const context = { approval: { record: { issue: identity } },
    execution: { id: '12345678-1234-1234-1234-123456789012', role: 'writer', actorId: 5,
      runId: 100, attempt: 1, jobId: 200 },
    runner: { repositoryId: 1, runnerId: 42, runId: 100, attempt: 1, jobId: 200,
      memberId: 5, sourceCommit: run.head_sha }, receipts: {} };
  const local = { contexts: [], errors: [],
    journal: { decisions: [], pending: false, sourceTime: at },
    wake: { decisions: [], pending: false, sourceTime: at } };
  let busy = false; let online = true; let active = false;
  const calls = [];
  const reader = { async get(path) {
    calls.push(path);
    if (path === '/user') return structuredClone(subject);
    if (path === '/repos/example/pool') return { id: 1, full_name: 'example/pool',
      private: false, archived: false, disabled: false, default_branch: 'main' };
    if (path === '/repos/example/project') return { id: 2,
      full_name: 'example/project', private: false };
    if (path === '/repos/example/pool/actions/workflows/50') return { id: 50,
      path: run.path, state: 'active' };
    if (path.includes('/runs?')) return {
      workflow_runs: active && path.includes('status=in_progress') ? [run] : [],
      total_count: active && path.includes('status=in_progress') ? 1 : 0,
    };
    if (path === '/repos/example/pool/actions/runs/100') return structuredClone(run);
    if (path.includes('/attempts/'))
      return { jobs: [structuredClone(job)], total_count: 1 };
    if (path === '/repos/example/pool/actions/jobs/200') return structuredClone(job);
    const match = path.match(/\/runners\/(\d+)$/);
    if (match) {
      const index = Number(match[1]) - 42;
      return { id: 42 + index, name: `runner-${index}`, busy,
        status: online ? 'online' : 'offline',
        labels: [{ name: 'self-hosted' }, { name: 'nibfin-user-5' }] };
    }
    if (path.includes('/issues?')) return [structuredClone(issue)];
    if (path.endsWith('/issues/7')) return structuredClone(issue);
    if (path.includes('/events?') || path.includes('/blocked_by?')) return [];
    throw Object.assign(new Error('Fixture resource missing'), { status: 404 });
  } };
  return { host, reader, calls, run, job, context, local,
    discover: async () => host,
    evidenceFactory: () => ({ issue: async () => local,
      phase: async () => { throw new Error('No live invocation'); },
      confirm: async () => {} }),
    executing() { active = true; busy = true; },
    offline() { online = false; },
  };
}
