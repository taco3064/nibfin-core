import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectConfig, readProjectConfig } from '../src/project-config.mjs';

const valid = {
  tools: { node: '22.15.0', python: '3.13.7', go: '1.24.0' },
  allowedDomains: ['pypi.org', 'files.pythonhosted.org'],
  skills: {
    shape: { mode: 'extend', path: '.nibfin/shape.md' },
    deliver: { mode: 'override', path: '.nibfin/deliver.md' },
    accept: { mode: 'extend', path: 'accept.md' },
  },
};

test('optional declarations retain absence and explicit emptiness', () => {
  for (const value of [{}, valid, { tools: {} }, { allowedDomains: [] },
    { skills: {} }, ...Object.entries(valid).map(([key, value]) => ({ [key]: value }))]) {
    const parsed = parseProjectConfig(value);
    assert.deepEqual(parsed, value);
    assert(Object.isFrozen(parsed));
    for (const nested of Object.values(parsed)) assert(Object.isFrozen(nested));
  }
});

test('invalid declarations reject types, authority settings and unsafe values', () => {
  const bad = [null, [], '', 1, true, { version: 1 }, { schemaVersion: 1 },
    ...['docker', 'credentials', 'command', 'privileged', 'runner', 'install']
      .map(key => ({ [key]: 'SECRET' })),
    { tools: [] }, { tools: null }, { tools: { ruby: '3.0.0' } },
    { skills: [] }, { skills: { review: {} } }, { skills: { scope: {} } },
    { skills: { deliver: null } }, { skills: { deliver: {} } },
    { allowedDomains: {} }, { allowedDomains: [null] },
  ];
  for (const version of ['', '*', '^22.0.0', '22', 'latest', 'v22.0.0',
    '22.0.0; SECRET', '22.0.0-beta', '01.2.3', '22.0.0\n', 22])
    bad.push({ tools: { node: version } });
  for (const domain of ['https://example.com', 'user@example.com', '*.example.com',
    'example.com/path', 'example.com:443', '127.0.0.1', '[::1]', 'localhost',
    'foo.local', 'foo.internal', 'foo.lan', 'foo.home', 'foo.arpa',
    'example.com.', 'http://example.com', '-bad.com', 'foo.123',
    'example.com\n', 'foo.localdomain'])
    bad.push({ allowedDomains: [domain] });
  for (const path of ['', '/etc/passwd', '../secret', 'a/../../secret',
    'C:\\secret', '\\\\host\\secret', 'a/../secret', 'a\u0000b', 1])
    bad.push({ skills: { deliver: { mode: 'extend', path } } });
  bad.push({ skills: { deliver: { mode: 'append', path: 'ok.md' } } },
    { skills: { deliver: { mode: 'extend', path: 'ok.md', command: 'SECRET' } } });
  for (const value of bad) assert.throws(() => parseProjectConfig(value), error => {
    assert.match(error.message, /^\.nibfin\.json:/);
    assert(!error.message.includes('SECRET'));
    return true;
  });
});

test('missing file differs from malformed, unreadable and escaping files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-config-'));
  const file = join(root, '.nibfin.json');
  try {
    assert.deepEqual(await readProjectConfig(root), {});
    await writeFile(file, '{}');
    assert.deepEqual(await readProjectConfig(root), {});
    await writeFile(file, JSON.stringify(valid));
    assert.deepEqual(await readProjectConfig(root), valid);
    await writeFile(file, '{SECRET');
    await assert.rejects(readProjectConfig(root), /root: invalid JSON/);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readProjectConfig(root), /file: expected a regular file/);
    await rm(file, { recursive: true });
    await symlink('/nonexistent', file);
    await assert.rejects(readProjectConfig(root), /file: expected a regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
