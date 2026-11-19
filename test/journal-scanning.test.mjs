import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, symlink, unlink }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationJournal, readWakeOrigins, requireWakeEffectsSettled }
  from '../src/operation-journal.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-journal-scanning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationJournal(root, { id: 'I_empty', repositoryId: 10 });
  assert.deepEqual(await journal.pauseEvidence(), { decisions: [], pending: false });
  const [name] = await readdir(root);
  return { root, journal, directory: join(root, name) };
}

test('observation-only journals have no wake origins or outstanding effects', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(await readWakeOrigins(f.root), []);
  await requireWakeEffectsSettled(f.root);
  assert.deepEqual(await readdir(f.directory), []);
});

test('an empty journal with an execution lock still blocks drain', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'execution.lock'), '{}', { mode: 0o600 });
  await assert.rejects(requireWakeEffectsSettled(f.root),
    { code: 'WRITER_NOT_PROVEN_TERMINATED' });
});

test('unknown effects and malformed or unsafe receipts remain fail closed', async t => {
  const f = await fixture(t);
  const request = { operation: 'wake', bindingHash: 'a'.repeat(64) };
  await f.journal.run(request, {
    admit: async () => request.bindingHash,
    perform: async () => { throw new Error('Unknown POST outcome'); },
    readBack: async () => assert.fail('No known run'),
  });
  await assert.rejects(requireWakeEffectsSettled(f.root),
    { code: 'EXTERNAL_EFFECT_UNKNOWN' });
  const path = join(f.directory, 'receipts.json');
  await writeFile(path, '{}');
  for (const scan of [readWakeOrigins, requireWakeEffectsSettled])
    await assert.rejects(scan(f.root));
  await unlink(path);
  await symlink(join(f.directory, 'missing'), path);
  for (const scan of [readWakeOrigins, requireWakeEffectsSettled])
    await assert.rejects(scan(f.root));
});
