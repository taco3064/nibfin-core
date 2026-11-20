import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedSettlement } from '../src/managed-credential-settlement.mjs';
import { makeBlockerReport } from '../src/blocker-report.mjs';
import { saveBlockerReport } from '../src/blocker-report-store.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { fixture as localFixture } from './local-work-fixture.mjs';

const linux = { skip: process.platform !== 'linux' };
const pending = { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' };

async function fixture(t, change = () => {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'nibfin-report-settlement-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const host = { stateRoot, uid: process.getuid() };
  const root = join(stateRoot, 'issue-2-7');
  const receipts = join(root, 'receipts');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const context = localFixture().context;
  change(context);
  const report = makeBlockerReport(context, 'deliver', {
    producer: 'core-native', code: 'EXTERNAL_EFFECT_UNKNOWN',
  });
  await saveBlockerReport(receipts, report);
  const path = join(receipts, 'reports', `${report.id}.json`);
  return { host, root, receipts, path, report, context };
}

test('passive reports coexist with settled journals without changing either', linux,
  async t => {
    const f = await fixture(t);
    const journal = new OperationJournal(f.receipts, f.context.approval.record.issue);
    await journal.run({ operation: 'deliver', bindingHash: 'a'.repeat(64) }, {
      admit: async () => 'a'.repeat(64), perform: async () => 'done',
      readBack: async () => 'a'.repeat(64),
    });
    const before = await readFile(f.path, 'utf8');
    await managedSettlement(f.host);
    assert.equal(await readFile(f.path, 'utf8'), before);
  });

test('a passive report never settles an actual pending journal', linux, async t => {
  const f = await fixture(t);
  const journal = new OperationJournal(f.receipts, f.context.approval.record.issue);
  await journal.run({ operation: 'deliver', bindingHash: 'a'.repeat(64) }, {
    admit: async () => 'a'.repeat(64),
    perform: async () => { throw new Error('Lost provider response'); },
    readBack: async () => assert.fail(),
  });
  await assert.rejects(managedSettlement(f.host), pending);
});

test('reports do not hide stage, recovery, evidence or journal locks', linux,
  async t => {
    for (const kind of ['stage', 'recovery', 'append', 'execution']) {
      const f = await fixture(t);
      let path = join(f.root, `${kind}.lock`);
      if (kind === 'append' || kind === 'execution') {
        const name = (kind === 'append' ? 'evidence-' : '') + 'b'.repeat(64);
        const directory = join(f.receipts, name);
        await mkdir(directory, { mode: 0o700 });
        path = join(directory, `${kind}.lock`);
      }
      await writeFile(path, '{}', { mode: 0o600 });
      await assert.rejects(managedSettlement(f.host), pending);
    }
  });

test('passive reports do not hide unknown operational sibling entries', linux,
  async t => {
    const f = await fixture(t);
    await writeFile(join(f.receipts, 'unknown.json'), '{}', { mode: 0o600 });
    await assert.rejects(managedSettlement(f.host), pending);
  });

test('the passive directory must remain owned, private and not a symlink', linux,
  async t => {
    const unsafe = await fixture(t);
    await chmod(join(unsafe.receipts, 'reports'), 0o755);
    await assert.rejects(managedSettlement(unsafe.host),
      { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
    const linked = await fixture(t);
    const directory = join(linked.receipts, 'reports');
    const original = join(linked.root, 'saved-reports');
    await rename(directory, original);
    await symlink(original, directory);
    await assert.rejects(managedSettlement(linked.host),
      { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
  });

test('stale or corrupt diagnostic contents never become pending effects', linux,
  async t => {
    const misbound = await fixture(t, context => {
      context.approval.record.issue.number = 8;
    });
    const before = await readFile(misbound.path, 'utf8');
    await managedSettlement(misbound.host);
    assert.equal(await readFile(misbound.path, 'utf8'), before);
    const changed = await fixture(t);
    await chmod(changed.path, 0o600);
    await writeFile(changed.path, 'broken historical JSON');
    const extra = join(changed.receipts, 'reports', 'historical-diagnostic.txt');
    await writeFile(extra, 'obsolete diagnostic format', { mode: 0o400 });
    await managedSettlement(changed.host);
    assert.equal(await readFile(changed.path, 'utf8'), 'broken historical JSON');
    assert.equal(await readFile(extra, 'utf8'), 'obsolete diagnostic format');
  });
