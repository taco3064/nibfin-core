import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGlobalInstructions } from '../src/host-adoption.mjs';

test('jobs read the current file and require an explicit source to exist', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nibfin-global-instructions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'AGENTS.md');
  const host = { mcp: { home } };
  assert.equal(await readGlobalInstructions(host), undefined);
  await assert.rejects(readGlobalInstructions({ globalInstructionsFile: file }), {
    code: 'GLOBAL_INSTRUCTIONS_UNAVAILABLE',
  });
  await writeFile(file, 'First version');
  assert.equal(await readGlobalInstructions(host), 'First version');
  await writeFile(file, 'Second version');
  assert.equal(await readGlobalInstructions({ globalInstructionsFile: file }),
    'Second version');
  const link = join(home, 'linked.md');
  await symlink(file, link);
  await assert.rejects(readGlobalInstructions({ globalInstructionsFile: link }), {
    code: 'GLOBAL_INSTRUCTIONS_UNAVAILABLE',
  });
});
