import { digest } from '../src/identity.mjs';

export function publicationFixture(shared = false) {
  const issue = { repository: 'owner/repo', repositoryId: 10,
    number: 2, id: 'I_target' };
  const runner = { repository: shared ? 'owner/pool' : issue.repository,
    repositoryId: shared ? 20 : issue.repositoryId,
    ...(shared ? { target: { repository: issue.repository,
      repositoryId: issue.repositoryId } } : {}),
    runId: 30, attempt: 1, jobId: 40, actorId: 3, memberId: 3,
    workflowId: 50, workflowPath: '.github/workflows/nibfin.yml',
    sourceCommit: 'a'.repeat(40), runnerId: 60, runnerName: 'slot',
    jobName: 'stage', eventName: 'workflow_dispatch',
  };
  const live = { node_id: issue.id, number: issue.number, body: 'approved Shape',
    updated_at: '2026-11-21T12:00:00Z' };
  const event = { action: 'edited', issue: structuredClone(live),
    changes: { body: { from: 'original requirements' } }, sender: { id: 3 } };
  const publication = { issue: structuredClone(issue), shapeHash: digest(live.body),
    transition: { before: digest(event.changes.body.from), after: digest(live.body),
      updatedAt: live.updated_at },
    execution: { actorId: 3, runId: 30, attempt: 1, jobId: 40 }, runner };
  const run = { id: 30, run_attempt: 1, status: 'in_progress', conclusion: null,
    event: 'workflow_dispatch', head_sha: runner.sourceCommit,
    repository: { id: runner.repositoryId, full_name: runner.repository },
    head_repository: { id: runner.repositoryId, full_name: runner.repository },
    head_branch: 'main', pull_requests: [],
    path: runner.workflowPath, workflow_id: 50, actor: { id: 3 },
    triggering_actor: { id: 3 }, referenced_workflows: [] };
  const job = { id: 40, run_id: 30, run_attempt: 1, head_sha: runner.sourceCommit,
    status: 'in_progress', conclusion: null, name: 'stage', runner_id: 60,
    runner_name: 'slot', labels: ['self-hosted',
      shared ? 'nibfin-shared' : 'nibfin-user-3'] };
  const workflow = { id: 50, path: runner.workflowPath, state: 'active' };
  const reads = [];
  const reader = {
    repository: async () => ({ id: runner.repositoryId, full_name: runner.repository,
      default_branch: 'main', private: false, archived: false, disabled: false }),
    issue: async () => structuredClone(live),
    get: async path => {
      reads.push(path);
      const root = `/repos/${runner.repository}/actions/`;
      const value = { [`${root}runs/30`]: run, [`${root}jobs/40`]: job,
        [`${root}workflows/50`]: workflow }[path];
      if (!value) throw new Error(`Unexpected path: ${path}`);
      return structuredClone(value);
    },
  };
  const options = { reader, issue, event, actorId: 3,
    readPublication: async () => structuredClone(publication), inspect: async () => {} };
  return { options, reader, issue, event, live, publication, runner,
    run, job, workflow, reads };
}
