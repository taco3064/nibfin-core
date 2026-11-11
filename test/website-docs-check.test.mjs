import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from '../website/scripts/docs-check.mjs';
import { digest } from '../website/scripts/source-claims.mjs';

test('real projection rejects contradicted labels and unlisted examples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doc15-source-'));
  const directory = join(root, 'website');
  try {
    for (const path of ['bin', 'src', 'website/evidence', 'website/src/content/docs']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await cp(path, join(root, path), { recursive: true });
    }
    // Neighboring documentation must coexist without entering this audit.
    await writeFile(join(directory, 'src/content/docs/neighbor.md'),
      '---\ntitle: Neighbor\n---\nSeparate maintained guide.\n');
    await checkDocs(directory);
    const owned = join(directory, 'src/content/docs/runners.md');
    const runner = await readFile(owned, 'utf8');
    await rm(owned);
    await assert.rejects(checkDocs(directory), /ENOENT/);
    await writeFile(owned, runner);
    const path = join(directory, 'src/content/docs/cli.md');
    const original = await readFile(path, 'utf8');
    const checklistPath = join(directory, 'evidence/checklist.json');
    const audit = await readFile(checklistPath, 'utf8');
    // Refresh article audit to test the independent command/status comparisons.
    const change = async (text) => {
      await writeFile(path, text);
      const data = JSON.parse(audit);
      data.pages['cli.md'].sha256 = digest(text);
      await writeFile(checklistPath, JSON.stringify(data));
    };
    await change(original.replace('Unverified release status', 'Released: candidate'));
    await assert.rejects(checkDocs(directory), /Contradicted availability/);
    await change(original.replace('not a released installation instruction.',
      'Released: installation instruction.'));
    await assert.rejects(checkDocs(directory), /represented as release/);
    await change(original + '\n```sh\ngh nibfin fabricated --flag\n```\n');
    await assert.rejects(checkDocs(directory), /Unlisted actionable command/);
    await change(original.replace('node bin/nibfin-core.mjs help',
      'node bin/nibfin-core.mjs help --invented'));
    await assert.rejects(checkDocs(directory), /Command differs/);
    await change(original);
    await checkDocs(directory);
    await writeFile(checklistPath, audit);
    const stale = JSON.parse(audit);
    stale.help.commands = stale.help.commands.filter((command) =>
      !command.startsWith('recover-review ') && !command.startsWith('promote-host '));
    await writeFile(checklistPath, JSON.stringify(stale));
    await assert.rejects(checkDocs(directory), /Help projection changed/);
    await writeFile(checklistPath, audit);
    await checkDocs(directory);
    const entry = join(root, 'bin/nibfin-core.mjs');
    await writeFile(entry, (await readFile(entry, 'utf8')) + '\n// changed\n');
    await assert.rejects(checkDocs(directory), /source comparison failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
