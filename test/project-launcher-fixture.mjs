import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryDelay } from '../scripts/retry-shared-runner.mjs';
import { boundedHostFile } from '../src/host-adoption.mjs';

const scenario = process.argv[2];
const observations = { adoption: 0, job: 0, approval: 0 };
function observe(name, value) {
  observations[name]++;
  if (scenario === 'retry' && observations[name] === 1)
    throw Object.assign(new Error('temporary read failure'), {
      status: 503, transientGitHubRead: true,
    });
  return value;
}

const root = await mkdtemp(join(tmpdir(), 'nibfin-project-launcher-'));
const issue = { id: 'I_target', number: 189,
  repository: 'owner/target', repositoryId: 2 };
const runner = { repository: 'owner/execution', repositoryId: 1,
  runnerId: 3, runnerName: 'runner', jobName: 'stage', memberId: 4,
  target: issue, sourceCommit: 'a'.repeat(40) };
const repository = { id: 2, full_name: issue.repository, default_branch: 'main',
  private: false, archived: false, disabled: false };
const approval = { repository, approvalHash: 'b'.repeat(64), scopeBinding: 'c'.repeat(64),
  record: { issue, roles: { writer: 4, author: 4 }, source: {} } };
const reader = {
  list: async path => path.endsWith('/runners')
    ? [{ id: 3, name: 'runner', status: 'online', busy: true,
      labels: [{ name: 'nibfin-user-4' }] }]
    : observe('job', [{ id: 30, name: 'stage', runner_id: 3,
      runner_name: 'runner', status: 'in_progress' }]),
  get: async path => {
    assert(!path.includes('/git/ref/'), 'REST main must use host observation');
    return { actor: { id: 4 }, head_sha: runner.sourceCommit };
  },
  repository: async () => assert.fail('Use the already observed repository'),
};
const adopted = { runner, approval: {}, isolation: { issue } };
const host = { stateRoot: root };
const context = { host, hostBytes: 'host', adopted, reader };
const moduleMock = (path, namedExports) => mock.module(path, { namedExports });
moduleMock('../src/notion-proposal.mjs', { readNotionProposal: async () => {} });
moduleMock('../src/host-relay.mjs', { relayHostCommand: async () => null });
moduleMock('../src/host-adoption.mjs', {
  boundedHostFile,
  loadHostAdoption: async () => observe('adoption', context),
  inspectHostAdoption: async () => {},
  readGlobalInstructions: async () => '', rootOwnedPath: async () => {},
});
moduleMock('../src/runner-binding.mjs', { readRunnerBinding: async () => ({}) });
moduleMock('../src/actions-identity.mjs', { actionsCaller: () => async () => {} });
moduleMock('../src/github-approval.mjs', {
  readProtectedApproval: async () => observe('approval', approval),
  readReviewers: async () => [],
});
moduleMock('../src/stage-continuation.mjs', { continueStages: async () => {
  throw Object.assign(new Error('continuation observation unavailable'), {
    status: 429, transientGitHubRead: true,
  });
} });
let mainReads = 0;
moduleMock('../src/github-host-read.mjs', { hostMainReader: () => async name => {
  assert.equal(name, issue.repository);
  mainReads++;
  if (mainReads === 1) {
    throw Object.assign(new Error('temporary host read failure'), {
      status: 503, transientGitHubRead: true,
    });
  }
  // A head-only host observation must reuse approval repository metadata.
  return { head: runner.sourceCommit };
} });
let work, runs = 0, prepared = 0, retired = 0, stopped = 0;
let unsafeContainers = false, unsafeJournal = false, unsafeMcp = false;
let failContainerSettlement = false;
moduleMock('../src/host-containers.mjs', { idleContainers: async () => {
  if (unsafeContainers) throw Object.assign(new Error(), {
    code: 'WRITER_NOT_PROVEN_TERMINATED',
  });
  return [];
} });
moduleMock('../src/operation-journal.mjs', { OperationJournal: class {
  async assertIdle() {
    if (failContainerSettlement) unsafeContainers = true;
    if (unsafeJournal) throw Object.assign(new Error(), {
      code: 'EXTERNAL_EFFECT_UNKNOWN',
    });
  }
} });
moduleMock('../src/mcp-job-host.mjs', { prepareHostJobMcp: async () => {
  prepared++;
  return {
    async retire(terminated) {
      assert.equal(terminated, true);
      if (unsafeMcp) throw new Error('MCP retirement unresolved');
      retired++;
    },
    stop() { stopped++; },
  };
} });
moduleMock('../src/workspace.mjs', { CandidateWorkspace: class {
  constructor(directory) { this.work = join(directory, 'work'); work = this.work; }
  async prepare(head) {
    assert.equal(head, runner.sourceCommit);
    await mkdir(this.work);
    await writeFile(join(this.work, '.nibfin.json'), '{invalid');
  }
} });
moduleMock('../src/codex-stage.mjs', { codexStageExecutor: async options => ({
  run: async () => {
    runs++;
    assert.equal(options.config.hostGitHubReads, true);
    assert.deepEqual(options.project, { tools: { node: '22.15.0' } });
    return { schemaVersion: 1, status: 'ready' };
  },
}) });

const env = { GITHUB_REPOSITORY: runner.repository, GITHUB_RUN_ID: '20',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
  RUNNER_ENVIRONMENT: 'self-hosted' };
const lock = join(root, 'issue-2-189', 'stage.lock');
try {
  const { launchStage } = await import('../src/host-launcher.mjs');
  const invalid = await launchStage('189', 'deliver', env);
  assert.equal(mainReads, 2, 'Workspace observation retries transient failure');
  assert.equal(invalid.status, 'denied');
  assert.equal(invalid.code, 'PROJECT_CONFIG_INVALID');
  assert.match(invalid.configurationError, /\.nibfin\.json: root: invalid JSON/);
  assert.equal(runs, 0);
  assert.equal(prepared, 1);
  assert.equal(retired, 1);
  assert.equal(stopped, 1);
  await assert.rejects(access(lock), { code: 'ENOENT' });
  await writeFile(join(work, '.nibfin.json'), '{"tools":{"node":"22.15.0"}}');
  assert.equal((await launchStage('189', 'deliver', env)).status, 'ready');
  assert.equal(runs, 1);
  assert.equal(mainReads, 2, 'Adopted workspace does not reread main');
  assert.equal(retired, 2);
  assert.equal(stopped, 2);
  await assert.rejects(access(lock), { code: 'ENOENT' });

  if (scenario === 'retry') {
    assert.deepEqual(observations, { adoption: 3, job: 3, approval: 3 });
    const pending = await launchStage('189', 'continue', env);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.code, 'GITHUB_READ_RETRY_PENDING');
    assert.equal(pending.retrySettled, true);
    assert.equal(pending.stage, 'continue');
    assert.equal(pending.retryRun, 20);
    assert.equal(pending.retryAttempt, 1);
    assert.equal(retryDelay(JSON.stringify(pending), 20, 1), 60000);
    assert.equal(retryDelay(JSON.stringify(pending), 21, 1), null);
    assert.equal(retryDelay(JSON.stringify(pending), 20, 2), null);
    assert.equal(retired, 3);
    assert.equal(stopped, 3);
    await assert.rejects(access(lock), { code: 'ENOENT' });
  } else {
    // Failed settlement must preserve the durable fence and deny another entry.
    await writeFile(join(work, '.nibfin.json'), '{invalid');
    unsafeJournal = scenario === 'journal';
    unsafeMcp = scenario === 'mcp';
    // Initial inspection succeeds; journal settlement makes containers uncertain.
    failContainerSettlement = scenario === 'containers';
    const unresolved = await launchStage('189', 'deliver', env);
    assert.equal(unresolved.status, 'pending');
    assert.equal(unresolved.code, scenario === 'journal' ? 'EXTERNAL_EFFECT_UNKNOWN'
      : scenario === 'containers' ? 'WRITER_NOT_PROVEN_TERMINATED'
        : 'HOST_EXECUTION_UNRESOLVED');
    await access(lock);
    assert.equal(runs, 1);
    assert.equal(retired, 2);
    assert.equal(stopped, 3);
    const retry = await launchStage('189', 'deliver', env);
    assert.equal(retry.code, 'HOST_EXECUTION_UNRESOLVED');
    assert.equal(prepared, 3);
  }
} finally {
  // All mocked resources are stopped; retain no disposable recovery fixture.
  await rm(root, { recursive: true, force: true });
}
