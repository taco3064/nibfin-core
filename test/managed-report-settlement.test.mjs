import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveBlockerReport, blockerReportsName } from '../src/blocker-report-store.mjs';
import { managedSettlement } from '../src/managed-credential-settlement.mjs';
import { digest } from '../src/identity.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), '.managed-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const receipts = join(root, 'issue-20-3', 'receipts');
  await mkdir(join(root, 'issue-20-3'), { mode: 0o700 });
  await mkdir(receipts, { mode: 0o700 });
  return { host: { stateRoot: root, uid: process.getuid() }, receipts };
}

test('persisted diagnostic reports do not block settled host work', async t => {
  const { host, receipts } = await fixture(t);
  const body = { stage: 'accept', outcome: 'blocked' };
  await saveBlockerReport(receipts, { ...body, id: digest(body) });
  await managedSettlement(host);
  const journal = join(receipts, 'a'.repeat(64));
  await mkdir(journal, { mode: 0o700 });
  const payload = { pending: 'b'.repeat(64) };
  await writeFile(join(journal, 'receipts.json'),
    JSON.stringify({ payload, hash: digest(payload) }), { mode: 0o600 });
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
  await rm(join(journal, 'receipts.json'));
  await writeFile(join(journal, 'execution.lock'), '{}', { mode: 0o600 });
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
});

test('diagnostic storage retains its private directory boundary', async t => {
  const { host, receipts } = await fixture(t);
  const reports = join(receipts, blockerReportsName);
  await mkdir(reports, { mode: 0o755 });
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
  await rm(reports, { recursive: true });
  await symlink(receipts, reports);
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
});
