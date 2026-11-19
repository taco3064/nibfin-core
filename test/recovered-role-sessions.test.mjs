import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { inspectRetirementSessions } from '../src/retirement-copies.mjs';

async function session(f, execution = f.execution) {
  const binding = { ...f.binding, memberId: execution.actorId, role: execution.role,
    executionId: execution.id, sessionId: execution.sessionId };
  const directory = join(f.issueRoot, 'agent', 'session-' + digest(binding));
  const home = join(directory, 'home'), path = join(directory, 'active.lock');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'auth-copy.json'), '{}', { mode: 0o600 });
  const bytes = JSON.stringify({ executionId: execution.id,
    bindingHash: digest(binding) });
  await writeFile(path, bytes, { mode: 0o600 });
  return { directory, home, path, bytes };
}

test('formal recovery retires its Agent marker and permits normal rollout inspection',
  async t => {
    const f = await deliverRecoveryFixture(t), s = await session(f);
    f.context.host.uid = process.getuid();
    const receipts = await f.store.load();
    const journal = await readFile(join(f.journalRoot, 'receipts.json'), 'utf8');
    await assert.rejects(inspectRetirementSessions(f.context.host),
      { code: 'RETIREMENT_WRITER_PENDING' });
    assert.equal((await f.recover()).status, 'completed');
    await assert.rejects(readFile(s.path), { code: 'ENOENT' });
    await assert.rejects(readFile(join(s.home, 'auth-copy.json')), { code: 'ENOENT' });
    await inspectRetirementSessions(f.context.host);
    assert.deepEqual(await f.store.load(), receipts);
    assert.equal(await readFile(join(f.journalRoot, 'receipts.json'), 'utf8'), journal);
    assert.equal((await f.recover()).status, 'completed');
  });

test('repeat recovery completes legacy marker cleanup and preserves other executions',
  async t => {
    const f = await deliverRecoveryFixture(t);
    assert.equal((await f.recover()).status, 'completed');
    const known = await session(f);
    const other = await session(f, { ...f.execution, id: 'other-execution' });
    assert.equal((await f.recover()).status, 'completed');
    await assert.rejects(readFile(known.path), { code: 'ENOENT' });
    assert.equal(await readFile(other.path, 'utf8'), other.bytes);
    assert.equal(await readFile(join(other.home, 'auth-copy.json'), 'utf8'), '{}');
  });

test('unproven termination preserves Agent marker, home and host fence', async t => {
  const f = await deliverRecoveryFixture(t), s = await session(f);
  f.options.containers = async () => { throw Error('unavailable'); };
  assert.equal((await f.recover()).status, 'pending');
  assert.equal(await readFile(s.path, 'utf8'), s.bytes);
  assert.equal(await readFile(join(s.home, 'auth-copy.json'), 'utf8'), '{}');
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
});
