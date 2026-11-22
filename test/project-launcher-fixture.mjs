import { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, readFile, writeFile, rm, stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryDelay } from '../scripts/retry-shared-runner.mjs';
import * as hostAdoption from '../src/host-adoption.mjs';
import * as hostContainers from '../src/host-containers.mjs';
import * as resources from '../src/managed-resource-admission.mjs';
import * as retirement from '../src/retirement-admission.mjs';
import { issueProgress } from '../src/issue-progress.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import {
  createMcpJobCopy, mcpCopyOwner, mcpCopyOwnerFile, mcpJobCopyPath,
} from '../src/mcp-copy-settlement.mjs';
import { removeMcpJobCopy } from '../src/mcp-job.mjs';
import { runPreparationScenario } from './launcher-preparation-scenarios.mjs';

const scenario = process.argv[2];
const preparationScenario = scenario.startsWith('prep-');
let beforeProgress = async () => {};
const diagnostic = () => new Error('preparation observation unavailable');
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
const approval = {
  repository, approvalHash: 'b'.repeat(64), scopeBinding: 'c'.repeat(64),
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
  issue: async () => ({ ...issue, body: 'requirements' }),
};
const adopted = { runner, approval: {}, isolation: { issue } };
const host = { stateRoot: root };
const context = { host, hostBytes: 'host', adopted, reader };
const moduleMock = (path, namedExports) => mock.module(path, { namedExports });
moduleMock('../src/issue-progress.mjs', {
  issueProgress: async (...args) => {
    await beforeProgress();
    return issueProgress(...args);
  },
});
moduleMock('../src/notion-proposal.mjs', { readNotionProposal: async () => {} });
moduleMock('../src/host-relay.mjs', { relayHostCommand: async () => null });
moduleMock('../src/host-adoption.mjs', {
  ...hostAdoption,
  loadHostAdoption: async () => observe('adoption', context),
  inspectHostAdoption: async () => {
    if (scenario === 'prep-inspection') throw diagnostic();
  },
  readGlobalInstructions: async () => '', rootOwnedPath: async () => {},
});
moduleMock('../src/managed-resource-admission.mjs', {
  ...resources, withResourcePreparationLock: action => action(),
});
moduleMock('../src/retirement-admission.mjs', {
  ...retirement, withInstalledPoolAdmission: action => action(),
});
moduleMock('../src/runner-binding.mjs', { readRunnerBinding: async () => ({}) });
moduleMock('../src/actions-identity.mjs', { actionsCaller: () => async () => {} });
moduleMock('../src/github-approval.mjs', {
  readProtectedApproval: async () => observe('approval', approval),
  readReviewers: async () => [],
});
moduleMock('../src/stage-continuation.mjs', { continueStages: preparationScenario
  ? continueStages : async () => {
  throw Object.assign(new Error('continuation observation unavailable'), {
    status: 429, transientGitHubRead: true,
  });
} });
let mainReads = 0;
moduleMock('../src/github-host-read.mjs', { hostMainReader: () => async name => {
  assert.equal(name, issue.repository);
  mainReads++;
  if (mainReads === 1 && !preparationScenario) {
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
moduleMock('../src/host-containers.mjs', {
  ...hostContainers,
  idleContainers: async () => {
    if (scenario === 'prep-unobserved') throw diagnostic();
    if (unsafeContainers) throw Object.assign(new Error(), {
      code: 'WRITER_NOT_PROVEN_TERMINATED',
    });
    return [];
  },
});
moduleMock('../src/operation-journal.mjs', { OperationJournal: class
  extends OperationJournal {
  constructor(...args) {
    super(...args);
    if (scenario === 'prep-incomplete') throw diagnostic();
  }
  async assertIdle() {
    if (preparationScenario) await super.assertIdle();
    if (failContainerSettlement) unsafeContainers = true;
    if (unsafeJournal) throw Object.assign(new Error(), {
      code: 'EXTERNAL_EFFECT_UNKNOWN',
    });
  }
} });
let copy;
moduleMock('../src/mcp-job-host.mjs', { prepareHostJobMcp: async ({ issueRoot }) => {
  prepared++;
  if (scenario === 'prep-mcp') throw diagnostic();
  if (scenario === 'prep-mcp-read') throw Object.assign(diagnostic(), {
    githubApiRead: true, status: 429,
  });
  // The real preparer leaves an owned Issue-root copy until retirement.
  const current = scenario === 'mcp' ? mcpJobCopyPath(issueRoot, { prepared }) : null;
  if (current) await createMcpJobCopy(current, await mcpCopyOwner());
  copy = current ?? copy;
  return {
    async retire(terminated) {
      assert.equal(terminated, true);
      if (unsafeMcp) throw new Error('MCP retirement unresolved');
      if (current) await removeMcpJobCopy(current);
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
  async comparisonBase() { return runner.sourceCommit; }
  async committedProjectConfig() { return null; }
} });
moduleMock('../src/installed-provider.mjs', {
  installedProviderExecutor: () => async options => {
    if (scenario === 'prep-compose') throw diagnostic();
    if (scenario === 'prep-compose-read') throw Object.assign(diagnostic(), {
      githubApiRead: true, status: 429,
    });
    return {
      run: async request => {
        runs++;
        assert.equal(options.config.hostGitHubReads, true);
        assert.deepEqual(options.project, { tools: { node: '22.15.0' } });
        return { schemaVersion: 1, stage: request.stage, status: 'ready' };
      },
    };
  },
});

const env = { GITHUB_REPOSITORY: runner.repository, GITHUB_RUN_ID: '20',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
  RUNNER_ENVIRONMENT: 'self-hosted' };
try {
  const { launchStage } = await import('../src/host-launcher.mjs');
  if (preparationScenario) {
    await runPreparationScenario({
      scenario, root, issue, runner, approval, env, launchStage, diagnostic,
      issueProgress, OperationJournal,
      setBeforeProgress: callback => { beforeProgress = callback; },
      setUnsafe: () => {
        unsafeContainers = scenario === 'prep-containers';
      },
      counters: () => ({ runs, prepared, retired, stopped }),
    });
  } else {
    const invalid = await launchStage('189', 'deliver', env);
    assert.equal(mainReads, 2, 'Workspace observation retries transient failure');
    assert.equal(invalid.status, 'denied');
    assert.equal(invalid.code, 'PROJECT_CONFIG_INVALID');
    assert.match(invalid.configurationError, /\.nibfin\.json: root: invalid JSON/);
    assert.equal(runs, 0);
    assert.equal(prepared, 0);
    assert.equal(retired, 0);
    assert.equal(stopped, 0);
    await writeFile(join(work, '.nibfin.json'), '{"tools":{"node":"22.15.0"}}');
    assert.equal((await launchStage('189', 'deliver', env)).status, 'ready');
    assert.equal(runs, 1);
    assert.equal(mainReads, 3, 'Each Job reads current main for its backend');
    assert.equal(retired, 1);
    assert.equal(stopped, 1);

    if (scenario === 'retry') {
      assert.deepEqual(observations, { adoption: 5, job: 4, approval: 3 });
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
      assert.equal(retired, 2);
      assert.equal(stopped, 2);
    } else {
      // Failed settlement reports the unresolved journal, containers or MCP.
      await writeFile(join(work, '.nibfin.json'), '{invalid');
      unsafeJournal = scenario === 'journal';
      unsafeMcp = scenario === 'mcp';
      if (unsafeMcp)
        await writeFile(join(work, '.nibfin.json'), '{"tools":{"node":"22.15.0"}}');
      // Initial inspection succeeds; journal settlement makes containers uncertain.
      failContainerSettlement = scenario === 'containers';
      const unresolved = await launchStage('189', 'deliver', env);
      assert.equal(unresolved.status, 'pending');
      assert.equal(unresolved.code, scenario === 'journal' ? 'EXTERNAL_EFFECT_UNKNOWN'
        : scenario === 'containers' ? 'WRITER_NOT_PROVEN_TERMINATED'
          : 'HOST_EXECUTION_UNRESOLVED');
      assert.equal(runs, unsafeMcp ? 2 : 1);
      assert.equal(retired, 1);
      assert.equal(stopped, unsafeMcp ? 2 : 1);
      const retry = await launchStage('189', 'deliver', env);
      if (scenario === 'containers') {
        // Writer inspection refuses the entry before workspace use.
        assert.equal(retry.code, 'LIVE_OBSERVATION_UNAVAILABLE');
        assert.equal(runs, 1);
        assert.equal(prepared, 1);
      } else if (scenario === 'journal') {
        // The fixture's invalid config stops this entry; release then reports
        // the unknown effect. No pre-workspace journal refusal exists yet
        // (follow-up production change).
        assert.equal(retry.code, 'EXTERNAL_EFFECT_UNKNOWN');
        assert.equal(prepared, 1);
      } else {
        // The unretired copy's owner (this live process) may still serve a
        // consumer: the entry stays Pending and prepares or runs nothing.
        assert.equal(retry.status, 'pending');
        assert.equal(retry.code, 'MCP_JOB_TERMINATION_UNPROVEN');
        assert.equal(prepared, 2);
        assert.equal(runs, 2);
        assert.equal(retired, 1);
        const [, id] = retry.reportReference.split(':');
        const report = JSON.parse(await readFile(join(root, 'issue-2-189',
          'receipts', 'reports', id + '.json'), 'utf8'));
        assert.equal(report.code, 'MCP_JOB_TERMINATION_UNPROVEN');
        await stat(join(copy, mcpCopyOwnerFile));
        // Once the recorded owner no longer exists, the entry clears the copy.
        const owner = join(copy, mcpCopyOwnerFile);
        const record = JSON.parse(await readFile(owner, 'utf8'));
        await rm(owner);
        await writeFile(owner, JSON.stringify({ ...record,
          startTicks: String(BigInt(record.startTicks) + 1n) }), { mode: 0o600 });
        unsafeMcp = false;
        const settled = await launchStage('189', 'deliver', env);
        assert.equal(settled.status, 'ready');
        assert.equal(prepared, 3);
        assert.equal(runs, 3);
        await assert.rejects(stat(copy), { code: 'ENOENT' });
      }
    }
  }
} finally {
  // All mocked resources are stopped; retain no disposable recovery fixture.
  await rm(root, { recursive: true, force: true });
}
