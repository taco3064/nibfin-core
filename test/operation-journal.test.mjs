import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MergeBeforeWrite } from '../src/github-write.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest } from '../src/identity.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationJournal(root, { id: 'I_target', repositoryId: 10 });
  const request = { operation: 'merge', bindingHash: 'a'.repeat(64) };
  let calls = 0;
  const adapters = { admit: async () => request.bindingHash,
    perform: async () => { calls++; }, readBack: async () => request.bindingHash };
  return { root, journal, request, adapters, calls: () => calls };
}

test('durable completed receipt prevents replay across Core instances', async t => {
  const f = await fixture(t);
  assert.equal((await f.journal.run(f.request, f.adapters)).status, 'completed');
  await f.journal.assertIdle();
  const next = new OperationJournal(f.root, { id: 'I_target', repositoryId: 10 });
  assert.deepEqual(await next.run(f.request, f.adapters),
    { status: 'denied', code: 'REPLAYED_OPERATION' });
  assert.equal(f.calls(), 1);
});

test('unknown effect and wrong read-back remain Pending and never retry', async t => {
  for (const failure of ['perform', 'readBack']) {
    const f = await fixture(t);
    if (failure === 'perform') f.adapters.perform = async () => {
      throw new Error('Connection lost after external write');
    };
    else f.adapters.readBack = async () => 'b'.repeat(64);
    assert.deepEqual(await f.journal.run(f.request, f.adapters),
      { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' });
    await assert.rejects(f.journal.assertIdle(), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
    let retries = 0;
    const retry = { ...f.adapters, perform: async () => { retries++; } };
    const attempt = { ...f.request, bindingHash: 'c'.repeat(64) };
    assert.equal((await f.journal.run(attempt, retry)).status, 'pending');
    assert.equal(retries, 0);
  }
});

test('failed fresh admission cannot reach a side effect', async t => {
  const f = await fixture(t); f.adapters.admit = async () => 'b'.repeat(64);
  assert.deepEqual(await f.journal.run(f.request, f.adapters),
    { status: 'denied', code: 'ADMISSION_FAILED' });
  assert.equal(f.calls(), 0);
});

test('recovery settles only the exact pending decision without repeating its write',
  async t => {
    const f = await fixture(t);
    const request = { ...f.request, operation: 'commit-pr' };
    await f.journal.run(request, { ...f.adapters, readBack: async () => undefined });
    const decision = digest(request);
    await assert.rejects(
      f.journal.recoverCommitPr('b'.repeat(64), async () => assert.fail('read-back')),
      { code: 'RECOVERY_DECISION_MISMATCH' },
    );
    await assert.rejects(f.journal.recoverCommitPr(decision, async () => undefined),
      { code: 'INVALID_RECOVERY_RECEIPT' });
    await assert.rejects(f.journal.assertIdle(), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
    const receiptHash = 'c'.repeat(64);
    const result = { status: 'completed', decisionId: decision, receiptHash };
    assert.deepEqual(
      await f.journal.recoverCommitPr(decision, async () => receiptHash), result);
    await f.journal.assertIdle();
    assert.deepEqual(
      await f.journal.recoverCommitPr(decision, async () => receiptHash), result);
    assert.equal(f.calls(), 1);
  });

test('concurrent writers and leftover leases stay Pending', async t => {
  const f = await fixture(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  f.adapters.perform = async () => { entered(); await finish; };
  const first = f.journal.run(f.request, f.adapters); await started;
  await assert.rejects(f.journal.assertIdle(), { code: 'WRITER_NOT_PROVEN_TERMINATED' });
  const second = new OperationJournal(f.root, { id: 'I_target', repositoryId: 10 });
  assert.equal((await second.run(f.request, f.adapters)).code,
    'WRITER_NOT_PROVEN_TERMINATED');
  release(); assert.equal((await first).status, 'completed');
  const [directory] = await readdir(f.root);
  await writeFile(join(f.root, directory, 'execution.lock'), '{"pid":0}',
    { mode: 0o600 });
  assert.equal((await second.run(f.request, f.adapters)).code,
    'WRITER_NOT_PROVEN_TERMINATED');
});

test('review recovery cannot settle a merge and needs exact review evidence', async t => {
  for (const operation of ['merge', 'review-pr']) {
    const f = await fixture(t);
    const request = { ...f.request, operation };
    const result = await f.journal.run(request, {
      ...f.adapters,
      perform: async () => { throw new Error('Unfinished'); },
    });
    assert.equal(result.code, 'EXTERNAL_EFFECT_UNKNOWN');
    await assert.rejects(
      f.journal.recoverReview(request.bindingHash, async () => undefined),
      { code: operation === 'merge' ? 'RECOVERY_DECISION_MISMATCH' :
        'INVALID_RECOVERY_RECEIPT' },
    );
    await assert.rejects(f.journal.assertIdle(), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
    if (operation === 'review-pr') {
      const proof = 'b'.repeat(64);
      assert.equal((await f.journal.recoverReview(request.bindingHash,
        async () => proof)).receiptHash, proof);
      await f.journal.assertIdle();
    }
  }
});

test('unsafe journal paths and tampered receipts prevent side effects', async t => {
  const f = await fixture(t); await f.journal.run(f.request, f.adapters);
  const [directory] = await readdir(f.root);
  const forged = '{"payload":{},"hash":"forged"}';
  await writeFile(join(f.root, directory, 'receipts.json'), forged, { mode: 0o600 });
  await assert.rejects(f.journal.run(f.request, f.adapters), /JOURNAL_CORRUPT/);
  await chmod(f.root, 0o777);
  await assert.rejects(f.journal.run(f.request, f.adapters),
    /UNTRUSTED_JOURNAL_DIRECTORY/);
  await chmod(f.root, 0o700);
  const g = await fixture(t), link = join(g.root, 'linked'); await symlink(f.root, link);
  const unsafe = new OperationJournal(link, { id: 'I_target', repositoryId: 10 });
  await assert.rejects(unsafe.run(f.request, f.adapters), /UNTRUSTED_JOURNAL_DIRECTORY/);
  assert.equal(f.calls(), 1);
});

test('a killed process leaves a durable lease and cannot be replaced automatically',
  { timeout: 10000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const f = await fixture(t);
  const moduleUrl = new URL('../src/operation-journal.mjs', import.meta.url).href;
  const code = `import { OperationJournal } from ${JSON.stringify(moduleUrl)};
    const subject = { id: 'I_target', repositoryId: 10 };
    const j = new OperationJournal(${JSON.stringify(f.root)}, subject);
    await j.run(${JSON.stringify(f.request)}, {
      admit:async()=>${JSON.stringify(f.request.bindingHash)},
      perform: async () => {
        process.stdout.write('effect-entered');
        await new Promise(() => { setInterval(() => {}, 1000); });
      },
      readBack:async()=>${JSON.stringify(f.request.bindingHash)}
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  const started = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString()),
    exited.then(() => { throw new Error(`Child exited before effect: ${stderr}`); }),
  ]);
  assert.equal(started, 'effect-entered');
  child.kill('SIGKILL'); await exited;
  const next = new OperationJournal(f.root, { id: 'I_target', repositoryId: 10 });
  const outcome = await next.run(f.request, f.adapters);
  assert.equal(outcome.code,
    'WRITER_NOT_PROVEN_TERMINATED');
  assert.equal(f.calls(), 0);
});

test('merge proven unsent clears durable intent and can be observed again', async t => {
  const f = await fixture(t);
  const perform = async () => { throw new MergeBeforeWrite(); };
  const stopped = await f.journal.run(f.request, { ...f.adapters, perform });
  assert.deepEqual(stopped, { status: 'pending', code: 'MERGE_REOBSERVE_REQUIRED' });
  assert.equal((await f.journal.run(f.request, f.adapters)).status, 'completed');
  assert.equal(f.calls(), 1);
});
