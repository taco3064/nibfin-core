import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  mkdtemp, mkdir, rm, readFile, writeFile, chmod, link, symlink, chown,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { acquireMcpEgress, acquireProjectEgress } from '../src/mcp-egress.mjs';
import { validMcpEgress, allowedHosts, policyPermits } from '../src/egress-proxy.mjs';

const execution = '00000000-0000-4000-8000-000000000001';
const nextExecution = '00000000-0000-4000-8000-000000000002';
const linux = { skip: process.platform !== 'linux' };

async function slot(t) {
  const prefix = fileURLToPath(new URL('../.mcp-egress-', import.meta.url));
  const root = await mkdtemp(prefix);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'policy');
  await mkdir(directory, { mode: 0o755 });
  return directory;
}
test('egress rejects expiry, commands, invalid names and wildcard routes', () => {
  const policy = { schemaVersion: 1, executionId: execution,
    hosts: ['mcp.notion.com'], expiresAt: Date.now() + 10000 };
  assert.equal(validMcpEgress(policy), true);
  for (const patch of [{ expiresAt: 0 }, { expiresAt: Date.now() + 3600000 },
    { hosts: ['*.notion.com'] }, { hosts: ['mcp.notion.com:443'] },
    { hosts: ['mcp.notion.com', 'mcp.notion.com'] }, { command: 'anything' }])
    assert.equal(validMcpEgress({ ...policy, ...patch }), false);
  assert.equal(allowedHosts.includes('mcp.notion.com'), false);
});

test('egress lease is exclusive, tamper-evident and explicitly retired', {
  skip: process.platform !== 'linux',
}, async t => {
  const directory = await slot(t);
  const lease = await acquireMcpEgress(directory, execution, ['mcp.notion.com']);
  const path = join(directory, 'current.json');
  assert.equal(validMcpEgress(JSON.parse(await readFile(path, 'utf8'))), true);
  await assert.rejects(acquireMcpEgress(directory, execution, ['example.com']),
    { code: 'EEXIST' });
  await lease.release();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const changed = await acquireMcpEgress(directory, execution, ['example.com']);
  await chmod(path, 0o644);
  await writeFile(path, '{}');
  await chmod(path, 0o444);
  await assert.rejects(changed.release(), { code: 'MCP_EGRESS_POLICY_CHANGED' });
});

test('a new project invocation replaces a departed child policy', linux, async t => {
  const directory = await slot(t);
  const module = new URL('../src/mcp-egress.mjs', import.meta.url).href;
  const script = `import { acquireProjectEgress } from ${JSON.stringify(module)};
await acquireProjectEgress(process.argv[1], process.argv[2], ['old.example.com']);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script,
    directory, execution], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const lease = await acquireProjectEgress(directory, nextExecution,
    ['new.example.com']);
  assert.equal(await policyPermits(directory, 'old.example.com', true), false);
  assert.equal(await policyPermits(directory, 'new.example.com', true), true);
  await assert.rejects(readFile(join(directory, '.project.json.next')),
    { code: 'ENOENT' });
  await lease.release();
});

test('an old project release cannot retire a newer invocation', linux, async t => {
  const directory = await slot(t);
  const old = await acquireProjectEgress(directory, execution, ['old.example.com']);
  const current = await acquireProjectEgress(directory, nextExecution,
    ['new.example.com']);
  const path = join(directory, 'project.json');
  const bytes = await readFile(path, 'utf8');
  await assert.rejects(old.release(), { code: 'MCP_EGRESS_POLICY_CHANGED' });
  assert.equal(await readFile(path, 'utf8'), bytes);
  await current.release();
});

test('owned partial and expired metadata do not prevent publication', linux,
  async t => {
    for (const bytes of ['{', JSON.stringify({ schemaVersion: 1,
      executionId: execution, hosts: ['old.example.com'], expiresAt: 0 })]) {
      const directory = await slot(t);
      await writeFile(join(directory, 'project.json'), bytes, { mode: 0o444 });
      await writeFile(join(directory, '.project.json.next'), '{', { mode: 0o444 });
      const lease = await acquireProjectEgress(directory, nextExecution, []);
      assert.equal(await policyPermits(directory, 'old.example.com', true), false);
      await assert.rejects(readFile(join(directory, '.project.json.next')),
        { code: 'ENOENT' });
      await lease.release();
    }
  });

test('failed publication preserves current bytes and removes its staging file', linux,
  async t => {
    const directory = await slot(t);
    const old = await acquireProjectEgress(directory, execution, ['old.example.com']);
    const path = join(directory, 'project.json');
    const bytes = await readFile(path, 'utf8');
    const rename = fs.rename;
    fs.rename = async () => {
      throw Object.assign(new Error('fixture'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(acquireProjectEgress(directory, nextExecution, []),
        { code: 'EIO' });
    } finally {
      fs.rename = rename;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(path, 'utf8'), bytes);
    await assert.rejects(readFile(join(directory, '.project.json.next')),
      { code: 'ENOENT' });
    await old.release();
  });

test('unsafe target and staging metadata are preserved and refused', linux,
  async t => {
    for (const name of ['project.json', '.project.json.next']) {
      for (const type of ['writable', 'hardlink', 'symlink', 'directory', 'fifo']) {
        const directory = await slot(t);
        const path = join(directory, name), source = join(directory, 'source');
        await writeFile(source, 'owned source', { mode: 0o444 });
        if (type === 'writable') await writeFile(path, '{}', { mode: 0o644 });
        if (type === 'hardlink') await link(source, path);
        if (type === 'symlink') await symlink(source, path);
        if (type === 'directory') await mkdir(path);
        if (type === 'fifo')
          assert.equal(spawnSync('mkfifo', ['--mode=444', path]).status, 0);
        const before = await fs.lstat(path);
        await assert.rejects(acquireProjectEgress(directory, nextExecution, []));
        assert.equal((await fs.lstat(path)).ino, before.ino);
        assert.equal(await readFile(source, 'utf8'), 'owned source');
      }
    }
  });

test('release refuses a FIFO without waiting for another process', linux, async t => {
  const directory = await slot(t), path = join(directory, 'project.json');
  const lease = await acquireProjectEgress(directory, execution, []);
  await rm(path);
  assert.equal(spawnSync('mkfifo', ['--mode=444', path]).status, 0);
  await assert.rejects(lease.release(), { code: 'MCP_EGRESS_POLICY_CHANGED' });
  assert.equal((await fs.lstat(path)).isFIFO(), true);
});

test('foreign target and staging files are preserved', {
  skip: process.platform !== 'linux' || process.getuid() !== 0,
}, async t => {
  for (const name of ['project.json', '.project.json.next']) {
    const directory = await slot(t), path = join(directory, name);
    await writeFile(path, '{}', { mode: 0o444 });
    await chown(path, 999, 999);
    await assert.rejects(acquireProjectEgress(directory, nextExecution, []),
      { code: 'MCP_EGRESS_POLICY_CHANGED' });
    assert.equal(await readFile(path, 'utf8'), '{}');
  }
});
