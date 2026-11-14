import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sharedServiceTemplate, writeSharedServiceTemplate,
} from '../src/shared-service-install.mjs';

test('the WSL service includes the reviewed mount restrictions', () => {
  const template = '[Service]\nExecStart=/usr/bin/true\n\n[Install]\n';
  const profile = '[Service]\nInaccessiblePaths=-/run/WSL\n';
  assert.equal(sharedServiceTemplate(template, ''), template);
  assert.equal(sharedServiceTemplate(template, profile),
    '[Service]\nExecStart=/usr/bin/true\nInaccessiblePaths=-/run/WSL\n\n[Install]\n');
});

test('install shared service template once and refuse changes or links', {
  skip: process.platform !== 'linux',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-shared-services-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unit = 'nibfin-shared-runner@.service';
  const path = join(directory, unit);
  const content = '[Service]\nExecStart=/usr/bin/true\n';
  const inspect = actual => assert.equal(actual, path);

  assert.equal(await writeSharedServiceTemplate(directory, content, inspect),
    'installed');
  assert.equal(await writeSharedServiceTemplate(directory, content, inspect),
    'unchanged');
  await assert.rejects(writeSharedServiceTemplate(directory, 'other', inspect),
    { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), content);
  await rm(path);
  await symlink('/nonexistent', path);
  await assert.rejects(writeSharedServiceTemplate(directory, content, inspect),
    { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
  assert.deepEqual(await readdir(directory), [unit]);
});
