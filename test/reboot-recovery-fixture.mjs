import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { issueStatePath } from '../src/host-fence.mjs';
import { acquireHostFence } from './legacy-stage-fence-fixture.mjs';
import { digest } from '../src/identity.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { evidenceBinding, stageRequestHash } from '../src/stages.mjs';
import { hostExecution } from '../src/host-launcher.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { recoverAdoptedOperation } from '../src/recover-commit-pr.mjs';
import { checkpointMessage } from '../src/delivery-checkpoint.mjs';

export const oldBoot = '11111111-1111-4111-8111-111111111111';
export const newBoot = '22222222-2222-4222-8222-222222222222';

export async function rebootFixture(t, stage = 'commit-pr', {
  native = false, initialPublication = false, providerApplied = true,
} = {}) {
  const scratch = resolve('.deliver-test-tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(scratch, 'nibfin-reboot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const subject = { id: 'I_target', repository: 'example/core',
    repositoryId: 10, number: 2 };
  const runner = { repository: subject.repository, repositoryId: 10, runId: 20,
    attempt: 1, jobId: 30, runnerId: 40, memberId: 3, workflowId: 50,
    sourceCommit: 'a'.repeat(40), jobName: 'adopted-stage' };
  const hostBytes = 'trusted-host';
  const context = { hostBytes, host: { stateRoot: root, memberId: 3 }, adopted: {
    isolation: { kind: 'linux-rootful-docker-v1', issue: subject }, runner,
    approval: {},
  } };
  const approval = { approvalHash: 'a'.repeat(64), record: { issue: subject,
    scope: { hash: 'b'.repeat(64) }, source: { commit: runner.sourceCommit },
    roles: { publisher: 3, author: 3 }, operations: ['commit-pr', 'review-pr'] } };
  const issueRoot = issueStatePath(root, subject);
  await mkdir(issueRoot, { mode: 0o700 });
  const binding = evidenceBinding({ approval });
  const receiptsRoot = join(issueRoot, 'receipts');
  await mkdir(receiptsRoot, { mode: 0o700 });
  const store = new EvidenceStore(receiptsRoot, binding);
  const shape = 'Published requirements';
  const head = 'c'.repeat(40);
  const candidate = { tree: 'd'.repeat(40), base: 'e'.repeat(40) };
  const artifacts = { shapeHash: await store.put(shape),
    candidateHash: await store.put(candidate) };
  const execution = hostExecution(runner, stage);
  const append = (stage, outcome, extra = {}) => store.append({
    schemaVersion: 1, stage, binding, execution, artifacts, outcome,
    findings: [], references: [], ...extra,
  });
  for (const [stage, outcome] of [
    ['shape', 'ready'], ['validate-shape', 'approved'], ['publish-shape', 'published'],
    ['deliver', 'ready'], ['pre-accept-hooks', 'passed'], ['accept', 'accepted'],
    ['post-accept-hooks', 'passed'],
  ]) await append(stage, outcome);
  const prArtifacts = { ...artifacts, prId: 'PR_target', prNumber: 9, head,
    base: candidate.base };
  if (!initialPublication)
    await append('commit-pr', 'published', { artifacts: prArtifacts });
  const previous = { schemaVersion: 1, stage: 'review-pr', binding, execution,
    artifacts: { ...prArtifacts, head: 'f'.repeat(40) }, outcome: 'approved' };
  if (stage === 'review-pr') {
    await store.append(previous);
    const session = digest({ ...binding, memberId: execution.actorId,
      role: execution.role, executionId: execution.id, sessionId: execution.sessionId });
    await mkdir(join(issueRoot, 'agent', `session-${session}`),
      { recursive: true, mode: 0o700 });
  }
  const run = { id: 20, actor: { id: 3 }, triggering_actor: { id: 3 },
    run_attempt: 1, workflow_id: 50, event: 'workflow_dispatch', status: 'completed',
    head_sha: runner.sourceCommit };
  const job = { id: 30, status: 'completed', run_id: 20,
    name: runner.jobName, runner_id: 40 };
  const issue = { node_id: subject.id, state: 'open', labels: [{ name: 'shaped' }],
    body: shape };
  const pr = { node_id: 'PR_target', number: 9, state: 'open', html_url: 'https://pr',
    head: { sha: head, repo: { id: 10 }, ref: 'candidate' },
    base: { repo: { id: 10 }, ref: 'main' } };
  const commit = { sha: head, tree: { sha: candidate.tree },
    parents: [{ sha: candidate.base }],
    message: 'Candidate: ' + artifacts.candidateHash };
  const data = {
    '/user': { id: 3 },
    '/repos/example/core/actions/runs/20': run,
    '/repos/example/core/actions/jobs/30': job,
    '/repos/example/core/pulls/9': pr,
    ['/repos/example/core/git/commits/' + head]: commit,
    '/repos/example/core/git/ref/heads/candidate': { object: { sha: head } },
  };
  if (initialPublication) {
    pr.head.ref = `nibfin/issue-${subject.number}-${head.slice(0, 12)}`;
    pr.title = `Deliver #${subject.number}`;
    pr.body = `Implements #${subject.number}.\n\nCandidate: ${artifacts.candidateHash}`;
    Object.assign(pr, { user: { id: 3 }, draft: false });
    commit.message = checkpointMessage(subject,
      { lifecycle: 0, shape: artifacts.shapeHash }, candidate);
    data['/repos/example/core/branches/nibfin%2Fdeliver-2'] = {
      name: 'nibfin/deliver-2', commit,
    };
    data['/repos/example/core/git/ref/heads/' + pr.head.ref] = { object: { sha: head } };
  }
  let writes = 0, observations = 0;
  context.reader = {
    get: async path => {
      if (!Object.hasOwn(data, path)) throw new Error('Unexpected read: ' + path);
      return structuredClone(data[path]);
    },
    list: async path => {
      if (path.endsWith('/issues/2/events')) return [];
      if (path.endsWith(`/commits/${head}/pulls`)) return providerApplied ? [pr] : [];
      return [{ id: 40, status: native ? 'online' : 'offline', busy: false,
        labels: [{ name: 'nibfin-user-3' }] }];
    },
    issue: async () => structuredClone(issue),
    write: async () => { writes++; throw new Error('Recovery must never write'); },
  };
  const requestArtifacts = stage === 'review-pr' ? { ...artifacts,
    prId: pr.node_id, prNumber: pr.number, head } : artifacts;
  const requestHash = stageRequestHash({ stage, binding, artifacts: requestArtifacts,
    execution, runner: 40, isolation: context.adopted.isolation.kind,
    body: shape, shaped: true });
  const request = { operation: stage, bindingHash: requestHash };
  const journal = new OperationJournal(receiptsRoot, subject);
  await journal.run(request, { admit: async () => requestHash,
    ...(native ? { recovery: { execution, runnerId: runner.runnerId } } : {}),
    perform: async () => { writes++; }, readBack: async () => undefined });
  const decision = digest(request);
  const journalRoot = join(receiptsRoot, digest({ issueId: subject.id,
    repositoryId: subject.repositoryId }));
  const lockPath = join(journalRoot, 'execution.lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, decision }),
    { mode: 0o600 });
  if (!native) await acquireHostFence(issueRoot, { host: digest(hostBytes),
    issueId: subject.id, execution: { runId: 20, jobId: 30, attempt: 1, actorId: 3 },
  }, async () => oldBoot);
  const fencePath = join(issueRoot, 'stage.lock');
  const fenceBytes = native ? null : await readFile(fencePath, 'utf8');
  const origin = native ? (await journal.pendingStageRecovery(stage)).pendingRecovery
    : null;
  const options = { observeBoot: async () => origin?.bootId ?? newBoot,
    ...(native ? { processes: async () => [] } : {}),
    containers: async () => { observations++; }, approvalReader: async () => approval };
  return { context, options, root, issueRoot, journalRoot, lockPath, fencePath,
    fenceBytes, store, journal, decision, previous, data, issue, pr, commit, run, job,
    binding, execution, artifacts, origin, writes: () => writes,
    observations: () => observations,
    recover: () => recoverAdoptedOperation(context, head, stage, options),
    changeFence: async change => {
      const fence = JSON.parse(await readFile(fencePath, 'utf8'));
      change(fence);
      await writeFile(fencePath, JSON.stringify(fence), { mode: 0o600 });
    },
  };
}
