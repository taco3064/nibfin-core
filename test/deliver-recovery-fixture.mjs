import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { issueStatePath, privateHostDirectory } from '../src/host-fence.mjs';
import { digest } from '../src/identity.mjs';
import { hostExecution } from '../src/host-launcher.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { recoverAdoptedDeliverFence } from '../src/recover-deliver-fence.mjs';
import { proveDeliverProcesses } from '../src/deliver-recovery-processes.mjs';
import { recoveryFixtureRoot } from './recovery-fixture-root.mjs';

export const boot = '11111111-1111-4111-8111-111111111111';

// Recovery consumes synthetic historical owners, not this test process. Native
// fence acquisition and /proc identity remain covered by host-fence.test.mjs.
export async function writeSyntheticRecoveryFence(directory, binding, {
  pid = 900001, bootId = boot, startTicks,
} = {}) {
  await privateHostDirectory(directory);
  const fence = { nonce: randomUUID(), binding, pid, bootId,
    ...(startTicks === undefined ? {} : { startTicks }) };
  await writeFile(join(directory, 'stage.lock'), JSON.stringify(fence), {
    flag: 'wx', mode: 0o600,
  });
  return fence;
}

export async function deliverRecoveryFixture(t, outer = 'deliver', rootOptions = {}) {
  const { root, environment } = await recoveryFixtureRoot(t, rootOptions);
  const subject = { id: 'I_target', repository: 'example/core',
    repositoryId: 10, number: 2 };
  const runner = { repository: subject.repository, repositoryId: 10, runId: 20,
    attempt: 1, jobId: 30, runnerId: 40, runnerName: 'slot', memberId: 3,
    workflowId: 50, sourceCommit: 'a'.repeat(40), jobName: 'adopted-stage' };
  const hostBytes = 'trusted-host';
  const context = { hostBytes, host: { stateRoot: root, memberId: 3,
    installation: { directory: '/opt/nibfin/core' } }, adopted: {
    isolation: { kind: 'linux-rootful-docker-v1', issue: subject }, runner,
    approval: {},
  } };
  const approval = { approvalHash: 'a'.repeat(64), record: { issue: subject,
    scope: { hash: 'b'.repeat(64) }, source: { commit: runner.sourceCommit },
    roles: { writer: 3 }, operations: ['deliver'] } };
  const issueRoot = issueStatePath(root, subject);
  await mkdir(issueRoot, { mode: 0o700 });
  const binding = evidenceBinding({ approval });
  const receiptsRoot = join(issueRoot, 'receipts');
  await mkdir(receiptsRoot, { mode: 0o700 });
  const store = new EvidenceStore(receiptsRoot, binding);
  const shape = 'Published requirements';
  const artifacts = { shapeHash: await store.put(shape) };
  const execution = hostExecution(runner, 'deliver');
  for (const [stage, outcome] of [
    ['shape', 'ready'], ['validate-shape', 'approved'], ['publish-shape', 'published'],
  ]) await store.append({ schemaVersion: 1, stage, binding,
    execution: hostExecution({ ...runner, runId: 19, jobId: 29 }, stage),
    artifacts, outcome,
    requirementsBody: shape, findings: [], references: [] });
  const input = join(issueRoot, 'agent', `execution-${execution.id}`, 'input');
  await mkdir(input, { recursive: true, mode: 0o700 });
  const retained = structuredClone({ approval, execution, runner,
    isolation: { profile: context.adopted.isolation.kind } });
  const inputPath = join(input, 'context.json');
  await writeFile(inputPath, JSON.stringify(retained), { mode: 0o644 });
  const invocationPath = join(input, 'invocation.json');
  await writeFile(invocationPath,
    JSON.stringify({ plan: { contract: { stage: 'deliver' } } }), { mode: 0o644 });
  const run = { id: 20, actor: { id: 3 }, triggering_actor: { id: 3 },
    run_attempt: 1, workflow_id: 50, event: 'workflow_dispatch', status: 'completed',
    conclusion: 'failure', head_sha: runner.sourceCommit };
  const job = { id: 30, status: 'completed', conclusion: 'failure', run_attempt: 1,
    run_id: 20, name: runner.jobName, runner_id: 40, runner_name: 'slot' };
  const issue = { node_id: subject.id, state: 'open',
    labels: [{ name: 'scope' }, { name: 'shaped' }], body: shape };
  const data = {
    '/user': { id: 3 },
    '/repos/example/core': { id: 10, full_name: 'example/core', private: false },
    '/repos/example/core/actions/runs/20/attempts/1': run,
    '/repos/example/core/actions/jobs/30': job,
  };
  context.reader = {
    get: async path => {
      if (!Object.hasOwn(data, path)) throw new Error('Unexpected read');
      return structuredClone(data[path]);
    },
    issue: async () => structuredClone(issue),
  };
  const journal = new OperationJournal(receiptsRoot, subject);
  let effects = 0;
  const request = { operation: 'deliver', bindingHash: 'c'.repeat(64) };
  await journal.run(request, { admit: async () => request.bindingHash,
    perform: async () => { effects++; return { id: 1 }; },
    readBack: async () => request.bindingHash });
  await writeSyntheticRecoveryFence(issueRoot, { host: digest(hostBytes),
    issueId: subject.id, execution: hostExecution(runner, outer) });
  const fencePath = join(issueRoot, 'stage.lock');
  const fenceBytes = await readFile(fencePath, 'utf8');
  const processes = [];
  let observations = 0;
  const options = { observeBoot: async () => boot,
    containers: async () => { observations++; return digest('empty'); },
    processes: (fence, options) => proveDeliverProcesses(fence, { ...options,
      census: async () => structuredClone(processes) }),
    approvalReader: async () => approval, inspectAdoption: async () => {} };
  return { root, environment, context, subject, runner, approval, store, journal, effects,
    execution, binding, artifacts, retained, inputPath, invocationPath,
    issueRoot, fencePath, fenceBytes, processes, options, job, run, issue, data,
    journalRoot: join(receiptsRoot, digest({ issueId: subject.id, repositoryId: 10 })),
    observations: () => observations,
    recover: () => recoverAdoptedDeliverFence(context, options),
  };
}
