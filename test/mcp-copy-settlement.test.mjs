import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpJobCopy, mcpCopyOwner, mcpCopyOwnerFile, mcpJobCopyPath,
  settleMcpJobCopies,
} from '../src/mcp-copy-settlement.mjs';
import { observedProcessIdentity } from '../src/host-memory-pressure.mjs';

const owner = { schemaVersion: 1, pid: 4242, startTicks: '777' };
const stopped = async () => null;
const alive = async pid => ({ pid, startTicks: '777' });

async function issueRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-copy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function copy(root, name, record = owner, files = {}) {
  const path = mcpJobCopyPath(root, { name });
  await createMcpJobCopy(path, record);
  for (const [file, bytes] of Object.entries(files))
    await writeFile(join(path, file), bytes, { mode: 0o600 });
  return path;
}

const exists = path => stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

test('fail-closed reader proves absence only from ENOENT', async () => {
  const stat = '42 (node) S' + ' 1'.repeat(18) + ' 9876 0 0';
  const enoent = Object.assign(Error('absent'), { code: 'ENOENT' });
  const eacces = Object.assign(Error('denied'), { code: 'EACCES' });
  assert.equal(await observedProcessIdentity(42, async () => { throw enoent; }), null);
  await assert.rejects(observedProcessIdentity(42, async () => { throw eacces; }),
    { code: 'EACCES' });
  await assert.rejects(observedProcessIdentity(42, async () => 'garbage'),
    { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  await assert.rejects(observedProcessIdentity(0), {
    code: 'PROCESS_IDENTITY_UNAVAILABLE',
  });
  assert.deepEqual(await observedProcessIdentity(42, async path => {
    assert.equal(path, '/proc/42/stat');
    return stat;
  }), { pid: 42, startTicks: '9876' });
});

test('owner identity is required and uses the native identity format', async () => {
  await assert.rejects(mcpCopyOwner(async () => null),
    { code: 'MCP_JOB_OWNER_UNAVAILABLE' });
  await assert.rejects(mcpCopyOwner(async () => ({ pid: process.pid + 1,
    startTicks: '5' })), { code: 'MCP_JOB_OWNER_UNAVAILABLE' });
  await assert.rejects(mcpCopyOwner(async pid => ({ pid, startTicks: 5 })),
    { code: 'MCP_JOB_OWNER_UNAVAILABLE' });
  assert.deepEqual(await mcpCopyOwner(async pid => ({ pid, startTicks: '5' })),
    { schemaVersion: 1, pid: process.pid, startTicks: '5' });
});

test('copy is created privately under the Issue root with its owner first',
  async t => {
    const root = await issueRoot(t);
    const path = mcpJobCopyPath(root, { job: 1 });
    assert.equal(join(path, '..'), join(root, 'mcp-copies'));
    await assert.rejects(createMcpJobCopy(path, { ...owner, extra: 1 }),
      { code: 'MCP_JOB_OWNER_UNAVAILABLE' });
    await createMcpJobCopy(path, owner);
    assert.equal((await stat(join(root, 'mcp-copies'))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    const record = join(path, mcpCopyOwnerFile);
    assert.equal((await stat(record)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), owner);
    assert.deepEqual(await readdir(path), [mcpCopyOwnerFile]);
    // One copy per Job binding: an existing copy is never reused.
    await assert.rejects(createMcpJobCopy(path, owner), { code: 'EEXIST' });
  });

test('absent or empty copy parent means no copy', async t => {
  const root = await issueRoot(t);
  assert.equal(await settleMcpJobCopies(root, alive), true);
  await mkdir(join(root, 'mcp-copies'), { mode: 0o700 });
  assert.equal(await settleMcpJobCopies(root, alive), true);
});

test('stopped owner without discovery clears the copy', async t => {
  const root = await issueRoot(t);
  const gone = await copy(root, 'gone', owner, { 'source.json': '{}' });
  const restarted = await copy(root, 'restarted', owner, { 'source.json': '{}' });
  const observed = [];
  assert.equal(await settleMcpJobCopies(root, async pid => {
    observed.push(pid);
    // PID reuse: a different start time is a different process.
    return observed.length === 1 ? null : { pid, startTicks: '778' };
  }), true);
  assert.deepEqual(observed, [4242, 4242]);
  assert.equal(await exists(gone), false);
  assert.equal(await exists(restarted), false);
  assert.deepEqual(await readdir(join(root, 'mcp-copies')), []);
});

test('copy without owner, source or discovery proves no consumer', async t => {
  const root = await issueRoot(t);
  const path = mcpJobCopyPath(root, { name: 'empty' });
  await mkdir(join(root, 'mcp-copies'), { mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
  assert.equal(await settleMcpJobCopies(root, alive), true);
  assert.equal(await exists(path), false);
});

test('unproven termination keeps every such copy', async t => {
  const root = await issueRoot(t);
  const live = await copy(root, 'live', owner, { 'source.json': '{}' });
  assert.equal(await settleMcpJobCopies(root, alive), false);
  assert.equal(await exists(join(live, 'source.json')), true);
  await rm(live, { recursive: true });

  const discovery = await copy(root, 'discovery', owner,
    { 'mcp-discovery.json': '{}' });
  assert.equal(await settleMcpJobCopies(root, stopped), false);
  assert.equal(await exists(join(discovery, 'mcp-discovery.json')), true);
  await rm(discovery, { recursive: true });

  const missing = await copy(root, 'missing', owner, { 'source.json': '{}' });
  await rm(join(missing, mcpCopyOwnerFile));
  assert.equal(await settleMcpJobCopies(root, stopped), false);
  assert.equal(await exists(join(missing, 'source.json')), true);
  await rm(missing, { recursive: true });

  const unobserved = await copy(root, 'unobserved');
  assert.equal(await settleMcpJobCopies(root, async () => {
    throw Object.assign(Error('denied'), { code: 'EACCES' });
  }), false);
  assert.equal(await exists(unobserved), true);
  await rm(unobserved, { recursive: true });
});

test('an owner record failing its checks keeps the copy', async t => {
  const root = await issueRoot(t);
  for (const [name, change] of [
    ['schema', record => writeFile(record, JSON.stringify({ ...owner,
      schemaVersion: 2 }))],
    ['extra', record => writeFile(record, JSON.stringify({ ...owner, host: 1 }))],
    ['ticks', record => writeFile(record, JSON.stringify({ ...owner,
      startTicks: 777 }))],
    ['json', record => writeFile(record, '{')],
    ['mode', record => chmod(record, 0o644)],
    ['size', record => writeFile(record, ' '.repeat(2048))],
  ]) {
    const path = await copy(root, name);
    await change(join(path, mcpCopyOwnerFile));
    assert.equal(await settleMcpJobCopies(root, stopped), false, name);
    assert.equal(await exists(path), true, name);
    await rm(path, { recursive: true });
  }
  const loose = await copy(root, 'loose');
  await chmod(loose, 0o755);
  assert.equal(await settleMcpJobCopies(root, stopped), false);
  assert.equal(await exists(loose), true);
});

test('one unproven copy keeps the entry Pending; provable ones still clear',
  async t => {
    const root = await issueRoot(t);
    const kept = await copy(root, 'kept', owner, { 'mcp-discovery.json': '{}' });
    const cleared = await copy(root, 'cleared');
    assert.equal(await settleMcpJobCopies(root, stopped), false);
    assert.equal(await exists(kept), true);
    assert.equal(await exists(cleared), false);
  });

test('state outside the Issue copy parent is not consulted', async t => {
  const root = await issueRoot(t);
  // A Runner-slot egress lease is per slot, not evidence for this Issue.
  await mkdir(join(root, 'mcp-policy'), { mode: 0o700 });
  await writeFile(join(root, 'mcp-policy', 'current.json'), '{}');
  await mkdir(join(root, 'mcp-jobs'), { mode: 0o700 });
  await mkdir(join(root, 'mcp-jobs', 'legacy.copies'), { mode: 0o700 });
  assert.equal(await settleMcpJobCopies(root, alive), true);
  assert.equal(await exists(join(root, 'mcp-policy', 'current.json')), true);
  assert.equal(await exists(join(root, 'mcp-jobs', 'legacy.copies')), true);
});

test('an untrusted copy parent is not a settlement result', async t => {
  const root = await issueRoot(t);
  await mkdir(join(root, 'mcp-copies'), { mode: 0o755 });
  await chmod(join(root, 'mcp-copies'), 0o755);
  await assert.rejects(settleMcpJobCopies(root, stopped),
    { code: 'UNTRUSTED_HOST_STATE' });
});
