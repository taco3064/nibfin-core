import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, mkdtemp, rm, chmod, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicationCovered, readWakePublication } from '../src/publication-wake.mjs';
import { projectIssueBodyChange } from '../src/issue-body-change.mjs';
import { projectManagedWake } from '../src/managed-wake.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { digest } from '../src/identity.mjs';
import { evidenceBinding, stages } from '../src/stages.mjs';
import { issueStatePath } from '../src/host-fence.mjs';
import { publicationFixture } from './publication-wake-fixture.mjs';

for (const shared of [false, true]) {
  test(`publication coverage observes the original execution (shared=${shared})`,
    async () => {
      const f = publicationFixture(shared);
      assert.equal(await publicationCovered(f.options), true);
      assert.equal(f.reads.length, 6);
      assert(f.reads.every(path => path.startsWith(`/repos/${f.runner.repository}/`)));
    });
}

test('real edits, legacy evidence and unrelated executions retain ordinary routing',
  async () => {
    const mutations = [
      f => { f.options.readPublication = undefined; },
      f => { f.options.readPublication = async () => null; },
      f => { delete f.event.changes; },
      f => { f.event.changes.body.from = 'manual change'; },
      f => { f.event.issue.body = 'manual change'; },
      f => { f.live.body = 'later requirements'; },
      f => { f.live.updated_at = '2026-11-21T12:00:01Z'; },
      f => { f.event.issue.updated_at = '2026-11-21T12:00:01Z'; },
      f => { f.event.sender.id = 99; },
      f => { f.publication.issue.number = 99; },
      f => { f.publication.shapeHash = 'b'.repeat(64); },
      f => { f.run.status = 'completed'; f.run.conclusion = 'success'; },
      f => { f.job.status = 'completed'; f.job.conclusion = 'cancelled'; },
      f => { f.run.status = 'queued'; },
      f => { f.run.run_attempt = 2; },
      f => { f.job.run_attempt = 2; },
      f => { f.run.actor.id = 99; },
      f => { f.run.head_sha = 'b'.repeat(40); },
      f => { f.run.repository.id = 99; },
      f => { f.job.run_id = 99; },
      f => { f.job.labels = ['self-hosted']; },
      f => { f.runner.reusable = { ref: 'missing', commit: 'a'.repeat(40) }; },
      f => { f.run.head_repository.full_name = 'wrong/repo'; },
      f => { f.workflow.state = 'disabled_manually'; },
      f => { f.runner.target = { repository: 'wrong/repo', repositoryId: 99 }; },
    ];
    for (const mutate of mutations) {
      const f = publicationFixture();
      mutate(f);
      assert.equal(Boolean(await publicationCovered(f.options)), false,
        String(mutate));
    }
  });

test('decision-boundary cancellation and edits do not establish coverage', async () => {
  for (const mutate of [f => { f.job.status = 'completed'; },
    f => { f.run.conclusion = 'cancelled'; },
    f => { f.live.body = 'new requirements'; },
    f => { f.publication.transition.before = 'b'.repeat(64); }]) {
    const f = publicationFixture();
    f.options.inspect = async () => mutate(f);
    assert.equal(Boolean(await publicationCovered(f.options)), false);
  }
});

test('failed provider reads remain unknown through the final observation', async () => {
  for (const after of [0, 3]) {
    const f = publicationFixture();
    const get = f.reader.get;
    let calls = 0;
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    f.reader.get = async path => {
      if (calls++ === after) throw error;
      return get(path);
    };
    await assert.rejects(publicationCovered(f.options), error);
  }
});

test('managed projection preserves transitions and rejects invalid digests', () => {
  const f = publicationFixture();
  Object.assign(f.event, { repository: { id: 10, full_name: 'owner/repo' } });
  Object.assign(f.event.issue, { id: 5, state: 'open', assignees: [], labels: [] });
  f.event.sender = { id: 3, login: 'owner', type: 'User' };
  const origin = { eventName: 'issues', repository: 'owner/repo', runId: 80, attempt: 1 };
  const projected = projectManagedWake(f.event, origin);
  assert.deepEqual(projected.event.bodyChange,
    projectIssueBodyChange(f.event).bodyChange);
  assert.deepEqual(projectManagedWake(projected.event, origin), projected);
  assert(!JSON.stringify(projected).includes(f.live.body));
  projected.event.bodyChange.before = 'invalid';
  assert.throws(() => projectManagedWake(projected.event, origin),
    /INVALID_ISSUE_BODY_CHANGE/);
});

test('read-only evidence works while append fence is held, without preparing state',
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'publication-evidence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = publicationFixture();
    const approval = { scopeBinding: 'a'.repeat(64),
      record: { issue: f.issue,
        operations: Object.values(stages).map(stage => stage.operation),
        roles: { publisher: 3, writer: 3, acceptor: 3, author: 3 } } };
    assert.equal(await readWakePublication(root, approval), null);
    assert.deepEqual(await readdir(root), []);
    const issueRoot = issueStatePath(root, f.issue);
    const receipts = join(issueRoot, 'receipts');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await chmod(issueRoot, 0o700);
    const binding = evidenceBinding({ approval });
    const store = new EvidenceStore(receipts, binding);
    const publicationHash = await store.put(f.publication);
    await store.append({ schemaVersion: 1, stage: 'publish-shape', binding,
      execution: f.publication.execution, outcome: 'published',
      artifacts: { shapeHash: f.publication.shapeHash, publicationHash } });
    const directory = join(receipts, `evidence-${digest(binding)}`);
    await writeFile(join(directory, 'append.lock'), '', { mode: 0o600 });
    const before = await readdir(directory);
    assert.deepEqual(await readWakePublication(root, approval), f.publication);
    assert.deepEqual(await readdir(directory), before);
    const blocked = { schemaVersion: 1, stage: 'deliver', binding,
      execution: f.publication.execution, outcome: 'blocked', artifacts: {} };
    // Release the fixture's simulated append fence to record a stopped stage.
    await unlink(join(directory, 'append.lock'));
    await store.append(blocked);
    assert.equal(await readWakePublication(root, approval), null);
    await store.append({ ...blocked, outcome: 'ready' });
    assert.deepEqual(await readWakePublication(root, approval), f.publication);
    approval.record.roles.writer = 4;
    assert.equal(await readWakePublication(root, approval), null);
    approval.record.roles.writer = 3;
    const operations = approval.record.operations;
    approval.record.operations = operations.filter(operation => operation !== 'accept');
    assert.equal(await readWakePublication(root, approval), null);
    approval.record.operations = operations;
    const readOnly = new EvidenceStore(receipts, binding, { readOnly: true });
    await assert.rejects(readOnly.put({}), /READ_ONLY_EVIDENCE/);
    await chmod(join(directory, publicationHash), 0o644);
    await assert.rejects(readWakePublication(root, approval), /UNTRUSTED_EVIDENCE_FILE/);
    await unlink(join(directory, publicationHash));
    await assert.rejects(readWakePublication(root, approval), { code: 'ENOENT' });
  });

test('shared forwarding preserves transition without forwarding either body', async t => {
  const { forwardSharedWake, readForwardedWake } = await import('../src/shared-wake.mjs');
  const f = publicationFixture(true);
  f.event.repository = { id: f.issue.repositoryId, full_name: f.issue.repository };
  const root = await mkdtemp(join(tmpdir(), 'publication-forward-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'event.json');
  await writeFile(path, JSON.stringify(f.event));
  let request;
  await forwardSharedWake({ status: 'resolved', issue_number: '2' }, {
    GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: '80', GITHUB_RUN_ATTEMPT: '1',
    NIBFIN_WAKE_TOKEN: 'fixture-token',
  }, async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ workflow_run_id: 81,
      html_url: 'https://github.com/taco3064/nibfin-core/actions/runs/81' });
  });
  const forwarded = readForwardedWake(JSON.stringify(request), f.issue);
  assert.deepEqual(forwarded.event.bodyChange,
    projectIssueBodyChange(f.event).bodyChange);
  assert.equal(await publicationCovered({ ...f.options, event: forwarded.event }), true);
  assert(!request.inputs.wake_event.includes(f.live.body));
  assert(!request.inputs.wake_event.includes(f.event.changes.body.from));
  assert(request.inputs.wake_event.length <= 4096);
});
