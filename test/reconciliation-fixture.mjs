import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueStatePath } from '../src/host-fence.mjs';
import { ControllerResult, controllerRequest } from '../src/controller-result.mjs';
import { digest } from '../src/identity.mjs';
import { stages } from '../src/stages.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';
import { hostExecution } from '../src/host-launcher.mjs';

// Synthetic Controller evidence and GitHub reads; no provider or host claims.
export function reconciliationFixture() {
  const issue = { id: 'I_original', number: 443, repository: 'owner/repo',
    repositoryId: 12 };
  const runner = { repositoryId: 12, runId: 21, attempt: 1, jobId: 31,
    memberId: 41, sourceCommit: 'a'.repeat(40) };
  const binding = { issueId: issue.id, approvalHash: 'b'.repeat(64),
    scopeHash: 'c'.repeat(64), sourceHash: 'd'.repeat(64) };
  const approval = { record: { issue, roles: Object.fromEntries(
    Object.values(stages).map(({ role }) => [role, runner.memberId])) } };
  const objects = new Map();
  const put = value => {
    const hash = digest(value);
    objects.set(hash, structuredClone(value));
    return hash;
  };
  const candidate = { repository: issue.repository, repositoryId: issue.repositoryId,
    issueId: issue.id, base: '1'.repeat(40), tree: '2'.repeat(40),
    paths: ['src/example.mjs'], changes: 'synthetic', obligations: {} };
  const content = { shapeHash: put('synthetic approved Shape'),
    candidateHash: put(candidate) };
  const published = { ...content, prId: 'PR_original', prNumber: 444,
    head: '3'.repeat(40), base: candidate.base };
  const ciHash = put({ prId: published.prId, head: published.head,
    base: published.base, testedSha: published.head, testMerge: '5'.repeat(40) });
  const merged = { ...published, ciHash, mergeCommit: '4'.repeat(40) };
  const receipts = Object.fromEntries(Object.keys(stages).map(stage => {
    const artifacts = ['shape', 'validate-shape', 'publish-shape'].includes(stage)
      ? { shapeHash: content.shapeHash }
      : stage === 'commit-pr' || stage === 'review-pr' ? published
        : stage === 'merge' || stage === 'close' ? merged : content;
    return [stage, { schemaVersion: 1, stage, binding,
      execution: hostExecution(runner, stage), artifacts: { ...artifacts },
      outcome: stageSuccess[stage], findings: [], references: ['synthetic'] }];
  }));
  const store = {
    put: async value => put(value),
    load: async () => structuredClone(receipts),
    get: async hash => {
      const value = objects.get(hash);
      if (!value || digest(value) !== hash) throw new Error('EVIDENCE_OBJECT_CORRUPT');
      return structuredClone(value);
    },
  };
  const live = { node_id: issue.id, number: issue.number, state: 'closed',
    url: 'https://api.github.com/repos/owner/repo/issues/443',
    labels: [{ name: 'delivered' }] };
  const pr = { node_id: published.prId, number: published.prNumber, state: 'closed',
    merged: true, head: { sha: published.head, repo: { id: issue.repositoryId } },
    base: { sha: published.base, repo: { id: issue.repositoryId } },
    merge_commit_sha: merged.mergeCommit };
  const commit = { sha: published.head, tree: { sha: candidate.tree },
    parents: [{ sha: candidate.base }] };
  const merge = { sha: merged.mergeCommit, tree: { sha: candidate.tree },
    parents: [{ sha: candidate.base }, { sha: published.head }] };
  const preview = { ...structuredClone(merge), sha: '5'.repeat(40) };
  const reads = [];
  const reader = {
    issue: async value => {
      reads.push('issue');
      if (digest(value) !== digest(issue)) throw new Error('Wrong Issue');
      return structuredClone(live);
    },
    get: async path => {
      reads.push(path);
      if (path === '/repos/owner/repo/pulls/444') return structuredClone(pr);
      if (path === `/repos/owner/repo/git/commits/${published.head}`)
        return structuredClone(commit);
      if (path === `/repos/owner/repo/git/commits/${merge.sha}`)
        return structuredClone(merge);
      if (path === `/repos/owner/repo/git/commits/${preview.sha}`)
        return structuredClone(preview);
      throw new Error('Unexpected read');
    },
  };
  const context = { reader, host: { stateRoot: '/unused' }, hostBytes: 'synthetic',
    adopted: { isolation: { issue } } };
  const input = { context, runner, approval, stage: 'continue',
    execution: hostExecution(runner, 'shape'),
    closeExecution: hostExecution(runner, 'close') };
  const counts = { acquired: 0, released: 0, inspected: 0, settled: 0 };
  const dependencies = {
    acquire: async () => {
      counts.acquired++;
      return { inspect: async () => {}, release: async () => { counts.released++; } };
    },
    inspect: async () => { counts.inspected++; },
    containers: async () => { counts.settled++; },
    journal: { assertIdle: async () => {} },
    progress: async () => ({ store, binding }),
  };
  return { input, dependencies, receipts, objects, put, live, pr, commit, reads,
    counts, store, binding, candidate, merge, preview };
}

export async function premergeFixture(t, stage = 'continue') {
  const f = reconciliationFixture();
  delete f.receipts.merge;
  delete f.receipts.close;
  f.receipts['review-pr'].outcome = 'changes_required';
  f.receipts['review-pr'].findings = ['synthetic correction'];
  f.live.state = 'open';
  f.live.labels = [];
  f.pr.state = 'open';
  f.pr.merged = false;
  f.input.stage = stage;
  f.input.execution = hostExecution(f.input.runner,
    stage === 'continue' ? 'shape' : stage);
  const stateRoot = await mkdtemp(join(tmpdir(), 'nibfin-premerge-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  f.input.context.host.stateRoot = stateRoot;
  const root = issueStatePath(stateRoot, f.input.approval.record.issue);
  await mkdir(root, { mode: 0o700 });
  f.evidence = new ControllerResult(root,
    controllerRequest({ ...f.input, binding: f.binding }), f.store);
  f.result = { schemaVersion: 1, stage: 'review-pr', status: 'denied',
    code: 'STAGE_REQUIRES_CORRECTION',
    receiptHash: digest(f.receipts['review-pr']) };
  f.save = async (result = f.result, execution = f.receipts['review-pr'].execution,
    iteration = 0) => {
    await f.evidence.begin();
    const hash = await f.evidence.record(result, execution, iteration);
    await f.evidence.settle(hash);
    return hash;
  };
  await f.save();
  return f;
}
