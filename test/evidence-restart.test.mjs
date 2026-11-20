import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { digest } from '../src/identity.mjs';

async function fixture(t) {
  const parent = fileURLToPath(new URL('../.nibfin-cache/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'evidence-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shape = stageFixture().receipts.shape;
  const store = new EvidenceStore(root, shape.binding);
  return { root, shape, store,
    pointer: stage => join(root, `evidence-${digest(shape.binding)}`, stage + '.json') };
}

const linux = { skip: process.platform !== 'linux' };

test('new author atomically retires old completion without deleting evidence', linux,
  async t => {
  const f = await fixture(t);
  await f.store.append(f.shape);
  const close = { ...stageFixture('close').receipts.merge,
    stage: 'close', outcome: 'closed' };
  const old = await f.store.append(close);
  const revised = { ...f.shape, execution: { ...f.shape.execution, runId: 2 } };
  await f.store.append(revised);
  assert.deepEqual(await f.store.load(), { shape: revised });
  assert.deepEqual(await f.store.get(old), close);
  const nextClose = { ...close, execution: { ...close.execution, runId: 2 } };
  await f.store.append(nextClose);
  await f.store.append(revised);
  assert.deepEqual((await f.store.load()).close, nextClose);
  const third = { ...revised, execution: { ...revised.execution, runId: 3 } };
  await f.store.append(third);
  await writeFile(f.pointer('close'), JSON.stringify({ receiptHash: old }));
  assert.deepEqual(await f.store.load(), { shape: third });
  assert.deepEqual(await f.store.get(old), close);
});

test('malformed selection metadata cannot silently hide a receipt', linux, async t => {
  const f = await fixture(t);
  await f.store.append(f.shape);
  const path = f.pointer('shape');
  const pointer = JSON.parse(await readFile(path, 'utf8'));
  pointer.supersedes = { close: true };
  await writeFile(path, JSON.stringify(pointer));
  await assert.rejects(f.store.load(), { code: 'EVIDENCE_OBJECT_CORRUPT' });
});
