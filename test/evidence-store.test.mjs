import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { digest } from '../src/identity.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-evidence-')); t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = stageFixture().receipts.shape, store = new EvidenceStore(root, receipt.binding);
  return { root, receipt, store };
}

test('immutable artifacts and stage receipts survive reopening under the same authority binding', async t => {
  const f = await fixture(t); const hash = await f.store.put('Shape body'); assert.equal(await f.store.get(hash), 'Shape body');
  assert.equal(await f.store.append(f.receipt), digest(f.receipt));
  const reopened = new EvidenceStore(f.root, f.receipt.binding);
  assert.deepEqual((await reopened.load()).shape, f.receipt);
  const different = new EvidenceStore(f.root, { ...f.receipt.binding, approvalHash: '0'.repeat(64) });
  assert.deepEqual(await different.load(), {});
  await assert.rejects(different.append(f.receipt), /BINDING_MISMATCH/);
});

test('tampered object and symlink pointer cannot become trusted receipts', async t => {
  const f = await fixture(t), hash = await f.store.append(f.receipt), [directory] = await readdir(f.root);
  await chmod(join(f.root, directory, hash), 0o600);
  await writeFile(join(f.root, directory, hash), '{}');
  await assert.rejects(f.store.load(), /EVIDENCE_OBJECT_CORRUPT/);
  const g = await fixture(t); await g.store.put('artifact'); const [other] = await readdir(g.root);
  await symlink('/nonexistent', join(g.root, other, 'shape.json'));
  await assert.rejects(g.store.load());
});
