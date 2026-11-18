import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareClaim, digest } from './source-claims.mjs';
import { checkCandidateInventory } from './candidate-claims.mjs';

// Validate the documented administrative interface, not a command snapshot.
function validateHelp(help) {
  assert(help && typeof help === 'object' && !Array.isArray(help),
    'Invalid help object');
  assert(Array.isArray(help.commands) && help.commands.length > 0 &&
    help.commands.every(command => typeof command === 'string' && command.trim()),
    'Invalid help commands');
  assert(typeof help.lifecycle === 'string' && help.lifecycle.trim(),
    'Invalid help lifecycle');
  const qualification = help.lifecycle.replace(/\s+/g, ' ').trim();
  assert(qualification.includes(
    'Stage execution requires administrator-adopted host configuration ' +
    'and live native admission.'), 'Invalid help lifecycle qualification');
}

export async function checkDocs(directory = 'website') {
  const load = (path) => readFile(join(directory, path), 'utf8');
  const checklist = JSON.parse(await load('evidence/checklist.json'));
  // The checklist is the single inventory for audited public guidance.
  const pages = Object.keys(checklist.pages);
  checkCandidateInventory(checklist, pages);
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
    const commands = [...text.matchAll(
      /```(?:sh|bash|shell|powershell|console)?\n([\s\S]*?)```/g)]
      .map((match) => match[1].trim());
    const listed = checklist.claims.filter((claim) => claim.page === page
      && claim.command).map((claim) => claim.command);
    const candidate = checklist.candidateCli.commands
      .filter((entry) => entry.pages.includes(page)).map((entry) => entry.command);
    assert.deepEqual(commands, [...candidate, ...listed],
      `Unlisted actionable command: ${page}`);
    for (const [, inline] of text.matchAll(/`([^`\n]+)`/g)) {
      assert(!/^(?:gh |npm |curl |wget |node |\.\/)/.test(inline),
        `Unlisted inline command: ${page}`);
    }
  }
  assert.equal(seen.size, checklist.claims.length, 'Orphan checklist claim');
  const claim = checklist.claims.find((claim) => claim.id === 'core-help');
  const entry = 'bin/nibfin-core.mjs';
  assert.equal(claim.command, `node ${entry} help`, 'Command/flag mismatch');
  const root = resolve(directory, '..');
  const help = spawnSync(process.execPath, [join(root, entry), 'help'],
    { encoding: 'utf8', timeout: 10000 });
  assert(!help.error, `Read-only help execution failed: ${help.error?.message}`);
  assert.equal(help.status, 0, 'Read-only help failed');
  validateHelp(JSON.parse(help.stdout));
  for (const unavailable of checklist.unavailable) {
    assert.equal(unavailable.status, 'Unverified');
    assert.equal(unavailable.release, null, 'Unobserved release must remain unavailable');
  }
  console.log('Documentation/source comparison passed; releases remain Unverified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkDocs(process.argv[2] || 'website');
}
