import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareClaim, digest } from './source-claims.mjs';

export async function checkDocs(directory = 'website') {
  const load = (path) => readFile(join(directory, path), 'utf8');
  const checklist = JSON.parse(await load('evidence/checklist.json'));
  // This audit owns onboarding; neighboring guides have their own checks.
  const pages = ['index.mdx', 'getting-started.mdx', 'installation.mdx',
    'cli.mdx', 'runners.mdx'];
  assert.deepEqual(Object.keys(checklist.pages).sort(), [...pages].sort(),
    'Onboarding audit inventory changed');
  const seen = new Set();
  for (const page of pages) {
    const text = await load(`src/content/docs/${page}`);
    const projection = checklist.pages[page];
    assert(projection, `Unlisted page: ${page}`);
    assert.equal(digest(text), projection.sha256, `Article audit changed: ${page}`);
    const claimsText = text.replace(/^\{\/\* ((?:claim:[\w-]+|\/claim)) \*\/\}$/gm,
      '<!-- $1 -->');
    const blocks = [...claimsText.matchAll(
      /<!-- claim:([\w-]+) -->\n([\s\S]*?)<!-- \/claim -->/g,
    )];
    for (const [, id, block] of blocks) {
      assert(!seen.has(id), `Duplicate claim: ${id}`);
      seen.add(id);
      const claim = checklist.claims.find((entry) => entry.id === id);
      assert(claim && claim.page === page, `Unlisted claim: ${id}`);
      if (!claim.command) compareClaim(claim, null);
      else assert.equal(claim.status, 'Unverified', 'No observed release evidence');
      assert(block.startsWith(claim.status), `Contradicted availability: ${id}`);
      assert(!/\b(?:Released|Installed):/.test(block),
        `Unverified candidate represented as release: ${id}`);
      if (claim.command) {
        assert.equal(claim.id, 'core-help', 'Only inspected read-only help exposed');
        assert(block.includes('candidate-only'), 'Candidate warning required');
        assert(block.includes(claim.commit), 'Adjacent source identity required');
        assert(block.includes(`\n${claim.command}\n`), 'Command differs from source');
      } else {
        assert(!/```/.test(block), 'Unavailable command must be withheld');
      }
    }
    const commands = [...text.matchAll(/```(?:sh|bash|shell)\n([\s\S]*?)```/g)]
      .map((match) => match[1].trim());
    const listed = checklist.claims.filter((claim) => claim.page === page
      && claim.command).map((claim) => claim.command);
    const candidate = page === 'cli.mdx' ? checklist.candidateCli.commands : [];
    assert.deepEqual(commands, [...candidate, ...listed],
      `Unlisted actionable command: ${page}`);
    for (const [, inline] of text.matchAll(/`([^`\n]+)`/g)) {
      assert(!/^(?:gh |npm |curl |wget |node |\.\/)/.test(inline),
        `Unlisted inline command: ${page}`);
    }
  }
  assert.equal(seen.size, checklist.claims.length, 'Orphan checklist claim');
  const source = checklist.sources.core;
  assert.equal(source.path, 'bin/nibfin-core.mjs', 'Fixed read-only help entry');
  const root = resolve(directory, '..');
  const bytes = await readFile(join(root, source.path));
  assert.equal(digest(bytes), source.sha256, 'Core source comparison failed');
  assert(bytes.toString().includes("command === 'help' && values.length === 0"),
    'Read-only help interface changed');
  const claim = checklist.claims.find((claim) => claim.id === 'core-help');
  assert.equal(claim.commit, source.commit, 'Core source identity mismatch');
  assert.equal(claim.command, `node ${source.path} help`, 'Command/flag mismatch');
  const help = spawnSync(process.execPath, [join(root, source.path), 'help'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, 'Read-only help failed');
  assert.deepEqual(JSON.parse(help.stdout), checklist.help, 'Help projection changed');
  for (const unavailable of checklist.unavailable) {
    assert.equal(unavailable.status, 'Unverified');
    assert.equal(unavailable.release, null, 'Unobserved release must remain unavailable');
  }
  console.log('Documentation/source comparison passed; releases remain Unverified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkDocs(process.argv[2] || 'website');
}
