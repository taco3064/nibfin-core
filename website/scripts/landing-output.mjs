import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArticleLinks } from './article-links.mjs';

// Exercise the production landing output, including the shared link validator.
export async function inspectLandingOutput(base, source = 'website/dist') {
  const original = await readFile(join(source, 'index.html'), 'utf8');
  assert.equal([...original.matchAll(/<h1\b/g)].length, 1, 'One primary heading');
  for (const text of ['Trusted delivery, from Issue to merge', 'Public Repository',
    'independent', 'Unverified: formal', 'Availability vocabulary']) {
    assert(original.includes(text), `Missing landing content: ${text}`);
  }
  for (const route of ['getting-started/', 'installation/', 'architecture/',
    'lifecycle/', 'security/', 'limitations/', 'cli/', 'runners/', 'theme/',
    'project-environment/']) {
    assert(original.includes(`href="${route}"`)
      || original.includes(`href="${base}${route}"`), `Missing discovery: ${route}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-landing-links-'));
  try {
    await cp(source, directory, { recursive: true });
    const index = join(directory, 'index.html');
    const destination = 'href="getting-started/"';
    const absolute = `href="${base}getting-started/"`;
    const target = original.includes(destination) ? destination : absolute;
    assert(original.includes(target), 'Missing onboarding action');
    await writeFile(index, original.replace(target,
      `href="${base}missing-landing-destination/"`));
    await assert.rejects(checkArticleLinks(base, directory), /ENOENT/);
    const fragment = 'lifecycle/#from-scope-to-closure';
    assert(original.includes(fragment), 'Missing lifecycle deep link');
    await writeFile(index, original.replace(fragment, 'lifecycle/#broken-landing'));
    await assert.rejects(checkArticleLinks(base, directory), /Broken article fragment/);
    await writeFile(index, original);
    await checkArticleLinks(base, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(`Landing discovery and broken-link controls passed: ${base}`);
}
