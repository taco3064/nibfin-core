import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { managedSettlement } from '../src/managed-credential-settlement.mjs';
import { recoverLegacyWakeOrigins } from '../src/rollout-legacy-wake.mjs';
import { writeRelayState } from '../src/relay-state.mjs';

async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'nibfin-wake-settlement-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const root = join(stateRoot, 'wake');
  await mkdir(root, { mode: 0o700 });
  const host = { stateRoot, uid: process.getuid() };
  const initial = { issue: { id: 'I_settled', repositoryId: 1 },
    coreCommit: 'a'.repeat(40) };
  const complete = async (directory, runId) => {
    const bindingHash = digest(initial);
    await new OperationJournal(directory, initial.issue).run({
      operation: 'wake', bindingHash, observation: initial,
    }, { admit: async () => bindingHash, perform: async () => runId,
      readBack: async () => bindingHash });
  };
  await complete(root, 10);
  return { root, host, initial, complete };
}

test('real settlement accepts polling metadata after a completed wake', async t => {
  const f = await fixture(t);
  await managedSettlement(f.host);
  await recoverLegacyWakeOrigins({ root: f.root, coreCommit: 'b'.repeat(40),
    ports: async () => ({ reconcile: async () => {},
      attempt: async () => ({ id: 10, run_attempt: 1,
        status: 'completed', conclusion: 'success' }) }) });
  await managedSettlement(f.host);
});

test('real settlement scans replacement journals and bounds the pending exemption',
  async t => {
    const f = await fixture(t);
    const name = 'legacy-' + 'c'.repeat(64);
    const directory = join(f.root, name), association = name + '.json';
    await mkdir(directory, { mode: 0o700 });
    await writeRelayState(f.root, association, { status: 'pending' });
    await assert.rejects(managedSettlement(f.host),
      { code: 'ROLLOUT_REPLACEMENT_PENDING' });
    await managedSettlement(f.host, { legacyReplacement: association });
    await f.complete(directory, 20);
    await writeRelayState(f.root, association, { status: 'scheduled' });
    await managedSettlement(f.host);
    const subject = join(directory,
      digest({ issueId: f.initial.issue.id, repositoryId: 1 }));
    const lock = join(subject, 'execution.lock');
    await writeFile(lock, '{}', { mode: 0o600 });
    await assert.rejects(managedSettlement(f.host),
      { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
    await unlink(lock);
    const journal = new OperationJournal(directory, f.initial.issue);
    await journal.run({ operation: 'wake', bindingHash: 'd'.repeat(64) }, {
      admit: async () => 'd'.repeat(64),
      perform: async () => { throw new Error('Lost POST'); },
      readBack: async () => assert.fail(),
    });
    await assert.rejects(managedSettlement(f.host, { legacyReplacement: association }),
      { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
  });

test('wake metadata cannot hide malformed state, unsafe paths or unknown entries',
  async t => {
    const f = await fixture(t);
    const path = join(f.root, 'legacy-poll.json');
    await writeRelayState(f.root, 'legacy-poll.json', { position: -1 });
    await assert.rejects(managedSettlement(f.host),
      { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
    await unlink(path);
    await symlink(join(f.root, 'missing'), path);
    await assert.rejects(managedSettlement(f.host));
    await unlink(path);
    await writeFile(join(f.root, 'unknown.json'), '{}', { mode: 0o600 });
    await assert.rejects(managedSettlement(f.host),
      { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
  });
