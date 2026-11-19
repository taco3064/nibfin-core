import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { RecoveryEvidenceSnapshot } from '../src/recovery-evidence-snapshot.mjs';

async function retains(f, code) {
  assert.deepEqual(await f.recover(), { status: 'pending', code });
  assert.equal(await fs.readFile(f.fencePath, 'utf8'), f.fenceBytes);
}

for (const mode of [0o700, 0o755]) {
  for (const layout of ['complete', 'empty', 'missing-input', 'context-only']) {
    test(`${mode.toString(8)} historical ${layout} input settles`, async t => {
      const f = await deliverRecoveryFixture(t, 'shape');
      await fs.chmod(f.input, mode);
      if (layout === 'empty' || layout === 'context-only')
        await fs.unlink(f.invocationPath);
      if (layout === 'empty') await fs.unlink(f.inputPath);
      if (layout === 'missing-input')
        await fs.rm(f.input, { recursive: true });
      const before = await f.store.load();
      assert.equal((await f.recover()).status, 'completed');
      assert.deepEqual(await f.store.load(), before);
      if (layout !== 'missing-input')
        assert.equal((await fs.stat(f.input)).mode & 0o777, mode);
      const name = (await fs.readdir(f.issueRoot)).find(n => n.startsWith('settled-'));
      const record = JSON.parse(await fs.readFile(join(f.issueRoot, name), 'utf8'));
      const retained = record.coverage.retained[0];
      assert.equal(retained.classification, layout === 'complete' ? 'complete-stage' :
        layout === 'context-only' ? 'incomplete-input' : 'absent-context');
      if (layout !== 'complete') {
        assert.equal(retained.stage, undefined);
        assert.equal(record.execution.role, 'author');
      }
    });
  }
}

for (const mode of [0o720, 0o702, 0o775, 0o777]) {
  test(`writable ${mode.toString(8)} historical input retains fence`, async t => {
    const f = await deliverRecoveryFixture(t);
    await fs.chmod(f.input, mode);
    await retains(f, 'UNTRUSTED_HOST_STATE');
  });
}

test('linked historical input retains fence', async t => {
  const f = await deliverRecoveryFixture(t);
  const moved = join(f.root, 'retained-input');
  await fs.rename(f.input, moved);
  await fs.symlink(moved, f.input);
  await retains(f, 'UNTRUSTED_EVIDENCE');
});

test('foreign input owner is rejected with controlled stat evidence', async t => {
  const f = await deliverRecoveryFixture(t);
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === f.input) stat.uid = process.getuid() === 0 ? 1 : 0;
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await retains(f, 'UNTRUSTED_HOST_STATE');
});

for (const change of ['replacement', 'membership', 'permissions']) {
  test(`0755 input ${change} after recording retains fence`, async t => {
    const f = await deliverRecoveryFixture(t);
    await fs.chmod(f.input, 0o755);
    f.options.afterRecord = async () => {
      if (change === 'replacement') {
        const moved = join(f.root, 'old-input');
        await fs.rename(f.input, moved);
        await fs.mkdir(f.input, { mode: 0o755 });
        for (const name of ['context.json', 'invocation.json'])
          await fs.copyFile(join(moved, name), join(f.input, name));
      }
      if (change === 'membership')
        await fs.writeFile(join(f.input, 'new.json'), '{}');
      if (change === 'permissions') await fs.chmod(f.input, 0o775);
    };
    await retains(f, change === 'permissions' ? 'UNTRUSTED_HOST_STATE' :
      'RECOVERY_EVIDENCE_CHANGED');
  });
}

for (const boundary of ['agent', 'execution', 'receipts', 'reports']) {
  test(`${boundary} directory still requires private permissions`, async t => {
    const f = await deliverRecoveryFixture(t);
    const paths = { agent: dirname(dirname(f.input)), execution: dirname(f.input),
      receipts: join(f.issueRoot, 'receipts'),
      reports: join(f.issueRoot, 'receipts', 'reports') };
    await fs.mkdir(paths[boundary], { recursive: true, mode: 0o700 });
    await fs.chmod(paths[boundary], 0o755);
    await retains(f, boundary === 'receipts' ? 'UNTRUSTED_EVIDENCE_DIRECTORY' :
      'UNTRUSTED_HOST_STATE');
  });
}

test('snapshot defaults remain private and historical paths must be canonical',
  async t => {
    const f = await deliverRecoveryFixture(t);
    await fs.chmod(f.input, 0o755);
    await assert.rejects(new RecoveryEvidenceSnapshot().directory(f.input),
      { code: 'UNTRUSTED_HOST_STATE' });
    await assert.rejects(new RecoveryEvidenceSnapshot().directory(
      `${f.input}/../input`, 'input-directory'), { code: 'UNTRUSTED_EVIDENCE' });
  });

test('a regular file cannot substitute for an input directory', async t => {
  const f = await deliverRecoveryFixture(t);
  await fs.rm(f.input, { recursive: true });
  await fs.writeFile(f.input, '{}', { mode: 0o600 });
  await retains(f, 'UNTRUSTED_HOST_STATE');
});

test('0755 input eligibility does not settle an unresolved Controller', async t => {
  const f = await deliverRecoveryFixture(t);
  await fs.chmod(f.input, 0o755);
  f.processes.push({ pid: 900001, state: 'S', startTicks: '1', parent: 1,
    command: ['helper'] });
  await retains(f, 'RECOVERY_CONTROLLER_UNRESOLVED');
});
