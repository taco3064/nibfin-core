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
    // Unrelated documentation must coexist without entering this audit.
    await writeFile(join(directory, 'src/content/docs/neighbor.md'),
      '---\ntitle: Neighbor\n---\nSeparate maintained guide.\n');
    await checkDocs(directory);
    const owned = join(directory, 'src/content/docs/runners.mdx');
    const runner = await readFile(owned, 'utf8');
    await rm(owned);
    await assert.rejects(checkDocs(directory), /ENOENT/);
    await writeFile(owned, runner);
    const path = join(directory, 'src/content/docs/cli.mdx');
    const original = await readFile(path, 'utf8');
    const checklistPath = join(directory, 'evidence/checklist.json');
    const audit = await readFile(checklistPath, 'utf8');
    // Refresh article audit to test the independent command/status comparisons.
    const change = async (text) => {
      await writeFile(path, text);
      const data = JSON.parse(audit);
      data.pages['cli.mdx'].sha256 = digest(text);
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
    const landing = join(directory, 'src/content/docs/index.mdx');
    const home = await readFile(landing, 'utf8');
    for (const [text, message] of [
      [home.replace('Unverified: formal', 'Released: formal'),
        /Contradicted availability/],
      [home + '\n```sh\ngh nibfin install\n```\n',
        /Unlisted actionable command/],
    ]) {
      await writeFile(landing, text);
      const data = JSON.parse(audit);
      data.pages['index.mdx'].sha256 = digest(text);
      await writeFile(checklistPath, JSON.stringify(data));
      await assert.rejects(checkDocs(directory), message);
    }
    await writeFile(landing, home);
    await writeFile(checklistPath, audit);
    await checkDocs(directory);
    const install = join(directory, 'src/content/docs/installation.mdx');
    const walkthrough = await readFile(install, 'utf8');
    const consent = JSON.parse(audit).candidateCli.commands
      .find((entry) => entry.route === 'managed').command;
    for (const [page, text, message] of [
      ['installation.mdx', walkthrough.replace('--consent-managed-login',
        '--invented-consent'), /Unlisted actionable command/],
      ['installation.mdx', walkthrough + '\n```sh\ngh nibfin fabricated\n```\n',
        /Unlisted actionable command/],
      ['cli.mdx', original + `\n\`\`\`sh\n${consent}\n\`\`\`\n`,
        /Unlisted actionable command/],
      ['installation.mdx', walkthrough.replace('Unverified formal release',
        'Installed: formal release'), /Contradicted availability/],
    ]) {
      const changed = join(directory, 'src/content/docs', page);
      const data = JSON.parse(audit);
      data.pages[page].sha256 = digest(text);
      await writeFile(changed, text);
      await writeFile(checklistPath, JSON.stringify(data));
      await assert.rejects(checkDocs(directory), message);
      await writeFile(changed, page === 'cli.mdx' ? original : walkthrough);
      await writeFile(checklistPath, audit);
    }
    await checkDocs(directory);
    for (const [page, before, after, message] of [
      ['execution-environments.mdx', 'Unverified: native', 'Installed: native',
        /Contradicted availability/],
      ['agent-providers.mdx', 'Planned: Claude', 'Released: Claude',
        /Contradicted availability/],
      ['architecture.mdx', 'Unverified: source', 'Installed: source',
        /Contradicted availability/],
      ['security.mdx', 'Unverified: these', 'Released: these',
        /Contradicted availability/],
      ['limitations.mdx', 'Unverified: desktop', 'Installed: desktop',
        /Contradicted availability/],
    ]) {
      const target = join(directory, 'src/content/docs', page);
      const source = await readFile(target, 'utf8');
      const text = source.replace(before, after);
      assert.notEqual(text, source, 'Mutation must exercise the claim');
      const data = JSON.parse(audit);
      data.pages[page].sha256 = digest(text);
      await writeFile(target, text);
      await writeFile(checklistPath, JSON.stringify(data));
      await assert.rejects(checkDocs(directory), message);
      await writeFile(target, source);
      await writeFile(checklistPath, audit);
    }
    for (const page of ['execution-environments.mdx', 'agent-providers.mdx']) {
      const target = join(directory, 'src/content/docs', page);
      const source = await readFile(target, 'utf8');
      for (const addition of [
        '\n```sh\ngh nibfin fabricated\n```\n',
        '\n`gh nibfin fabricated`\n',
      ]) {
        const data = JSON.parse(audit);
        const text = source + addition;
        data.pages[page].sha256 = digest(text);
        await writeFile(target, text);
        await writeFile(checklistPath, JSON.stringify(data));
        await assert.rejects(checkDocs(directory), /Unlisted .*command/);
      }
      await writeFile(target, source);
      await writeFile(checklistPath, audit);
    }
    for (const [mutate, message] of [
      [data => { data.candidateCli.status = 'Released'; },
        /Candidate availability/],
      [data => { data.candidateCli.release = 'unobserved'; },
        /cannot certify a release/],
      [data => { data.candidateCli.providers.claude = 'Unverified'; },
        /Provider availability differs/],
      [data => { data.candidateCli.commands.push({
        command: 'gh nibfin init --repo OWNER/REPO --agent claude',
        route: 'candidate', pages: ['agent-providers.mdx'],
      }); }, /Unavailable provider command/],
      [data => { data.candidateCli.commands.push({
        command: 'gh nibfin init --repo OWNER/REPO --agent=claude',
        route: 'candidate', pages: ['agent-providers.mdx'],
      }); }, /Unavailable provider command/],
    ]) {
      const data = JSON.parse(audit);
      mutate(data);
      await writeFile(checklistPath, JSON.stringify(data));
      await assert.rejects(checkDocs(directory), message);
      await writeFile(checklistPath, audit);
    }
    await checkDocs(directory);
    const entry = join(root, 'bin/nibfin-core.mjs');
    const source = await readFile(entry, 'utf8');
    await writeFile(entry, source + '\n// changed\n');
    await checkDocs(directory);
    const additive = source.replace("        'contract',",
      "        'unrelated-admin',\n        'contract',");
    assert.notEqual(additive, source);
    await writeFile(entry, additive);
    await checkDocs(directory);
    assert.equal(await readFile(checklistPath, 'utf8'), audit,
      'Compatible candidate edits must not refresh evidence');
    for (const [text, message] of [
      [source.replace("command === 'help'", "command === 'broken-help'"),
        /Read-only help failed/],
      ["console.log('not JSON');", /Unexpected token/],
      ['process.exit(2);', /Read-only help failed/],
      ['process.kill(process.pid, \'SIGTERM\');', /Read-only help failed/],
      ...[null, [], {}, { commands: [] },
        { commands: [''] }, { commands: ['  '] }, { commands: [42] },
        { commands: ['admin'], lifecycle: '' },
        { commands: ['admin'], lifecycle: 'No admission required.' },
      ].map(value => [
        `console.log(${JSON.stringify(JSON.stringify(value))});`, /Invalid help/,
      ]),
    ]) {
      await writeFile(entry, text);
      await assert.rejects(checkDocs(directory), message);
    }
    await rm(entry);
    await assert.rejects(checkDocs(directory), /Read-only help failed/);
    await writeFile(entry, source);
    await checkDocs(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
