import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, chmod }
  from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { readObservationFile } from '../src/local-work-files.mjs';
import { localEvidence } from '../src/local-work-evidence.mjs';
import { readLocalWorkInput } from '../src/local-work-input.mjs';
import { digest } from '../src/identity.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { collectLocalWork } from '../src/local-work-observation.mjs';
import { fixture, identity } from './local-work-fixture.mjs';

async function temporary(use) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-observation-'));
  try { await use(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const json = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });

test('owner checked bounded reads reject symlinks, writable and oversized files',
  async () => temporary(async root => {
    const path = join(root, 'evidence.json');
    await json(path, { allowed: true });
    const observed = await readObservationFile(path, process.getuid());
    assert.deepEqual(JSON.parse(observed.bytes),
      { allowed: true });
    await assert.rejects(readObservationFile(path, process.getuid() + 1));
    await assert.rejects(readObservationFile(path, process.getuid(), 2));
    const link = join(root, 'symlink.json'); await symlink(path, link);
    await assert.rejects(readObservationFile(link, process.getuid()));
    await chmod(path, 0o666);
    await assert.rejects(readObservationFile(path, process.getuid()));
    await chmod(path, 0o600);
    const directory = join(root, 'directory'); await mkdir(directory, { mode: 0o700 });
    const parent = join(root, 'parent'); await symlink(directory, parent);
    await json(join(directory, 'data'), {});
    await assert.rejects(readObservationFile(join(parent, 'data'), process.getuid()));
  }));

test('missing evidence does not create directories or journals', async () =>
  temporary(async root => {
    const before = await readdir(root);
    const evidence = localEvidence({
      stateRoot: root, uid: process.getuid(), subjectId: 5,
    });
    const result = await evidence.issue(identity);
    assert.equal(result.contexts.length, 0);
    assert.equal(result.journal, null);
    assert.ok(result.errors.includes('UNAVAILABLE'));
    await evidence.confirm();
    assert.deepEqual(await readdir(root), before);
  }));

test('context and session lock need independent live invocation evidence for phase',
  async () => temporary(async root => {
    const { context } = fixture();
    context.execution.sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    context.stateBinding = { issueId: identity.id, approvalHash: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64) };
    const agent = join(root, 'issue-2-7', 'agent');
    const input = join(agent, `execution-${context.execution.id}`, 'input');
    await mkdir(input, { recursive: true, mode: 0o700 });
    await json(join(input, 'context.json'), context);
    await json(join(input, 'invocation.json'), {
      plan: { contract: { stage: 'deliver' } },
    });
    const execution = context.execution;
    const binding = { ...evidenceBinding(context), memberId: execution.actorId,
      role: execution.role, executionId: execution.id, sessionId: execution.sessionId };
    const session = join(agent, `session-${digest(binding)}`);
    await mkdir(session, { mode: 0o700 });
    await json(join(session, 'active.lock'), {
      executionId: execution.id, bindingHash: digest(binding),
    });
    const host = { stateRoot: root, uid: process.getuid(), subjectId: 5 };
    const absent = localEvidence(host, { activity: async () => null });
    const discovered = await absent.issue(identity);
    assert.equal(discovered.contexts.length, 1);
    await assert.rejects(absent.phase(discovered.contexts[0]));
    let rechecked = false;
    const live = localEvidence(host, { activity: async () => ({
      confirm: async () => { rechecked = true; },
    }) });
    const current = (await live.issue(identity)).contexts[0];
    const phase = await live.phase(current);
    assert.equal(phase.stage, 'deliver');
    await phase.confirm(); await live.confirm();
    assert.equal(rechecked, true);
    await mkdir(join(input, '..', 'output'), { mode: 0o700 });
    await json(join(input, '..', 'output', 'result.json'), { outcome: 'ready' });
    await assert.rejects(live.phase(current));
  }));

for (const input of ['{}', '{"token":"contains whitespace"}',
  '{"token":"secret","stateRoot":"/private"}', 'x'.repeat(17409)]) {
  test(`private input rejects malformed or extended requests (${input.length} bytes)`,
    async () => {
      const stream = new PassThrough(); stream.end(input);
      await assert.rejects(readLocalWorkInput(stream));
    });
}

test('successful wake completion retains queue correlation without a pending effect',
  async () => temporary(async root => {
    const wakeRoot = join(root, 'wake');
    await mkdir(wakeRoot, { mode: 0o700 });
    const receiptsRoot = join(root, 'issue-2-7', 'receipts',
      digest({ issueId: identity.id, repositoryId: identity.repositoryId }));
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const empty = { schemaVersion: 1, pending: null, completed: [] };
    await json(join(receiptsRoot, 'receipts.json'),
      { payload: empty, hash: digest(empty) });
    const journal = new OperationJournal(wakeRoot, identity);
    const bindingHash = digest({ dispatch: 'first' });
    const request = { operation: 'wake', bindingHash };
    const callbacks = { admit: async () => bindingHash,
      perform: async () => 100, readBack: async () => bindingHash };
    assert.equal((await journal.run(request, callbacks)).status, 'completed');
    const input = fixture(); input.executing();
    input.job.status = 'queued'; input.job.runner_id = 0;
    input.job.runner_name = null;
    const host = { stateRoot: root, uid: process.getuid(), subjectId: 5 };
    input.evidenceFactory = () => localEvidence(host);
    const result = await collectLocalWork('private-test-token', input);
    assert.equal(result.work[0].activity.value, 'queued');
    assert.equal(result.work[0].native.runId, 100);
    assert.equal(result.work[0].phase.value, null);
    assert.equal(result.work[0].executionBlocker.code, 'NO_PENDING_EFFECT');
    assert.equal(result.work[0].waiting.value, null);
    const observed = await localEvidence(host).issue(identity);
    assert.equal(observed.wake.pending, false);
    assert.equal(observed.wake.dispatchRunId, null);
    assert.deepEqual(observed.wake.dispatchRunIds, [100]);
    assert.equal(observed.wake.dispatchUnknown, false);
    assert.equal((await journal.run(request, callbacks)).code, 'REPLAYED_OPERATION');
    const nextHash = digest({ dispatch: 'second' });
    await journal.run({ operation: 'wake', bindingHash: nextHash }, {
      admit: async () => nextHash, perform: async () => 101,
      readBack: async () => nextHash,
    });
    assert.deepEqual((await localEvidence(host).issue(identity))
      .wake.dispatchRunIds, [100, 101]);
    const payload = { schemaVersion: 1, pending: null,
      completed: [digest({ legacy: true })] };
    const path = join(wakeRoot,
      digest({ issueId: identity.id, repositoryId: identity.repositoryId }),
      'receipts.json');
    await json(path, { payload, hash: digest(payload) });
    const legacy = await collectLocalWork('private-test-token', input);
    assert.equal(legacy.work[0].activity.value, null);
    assert.equal(legacy.work[0].waiting.value, null);
    assert.equal((await localEvidence(host).issue(identity))
      .wake.dispatchUnknown, true);
  }));
