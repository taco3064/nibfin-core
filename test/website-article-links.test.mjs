import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArticleLinks } from '../website/scripts/article-links.mjs';

test('all article links and fragments use generated targets at both bases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doc15-links-'));
  try {
    await mkdir(join(directory, 'article'));
    await writeFile(join(directory, 'article/index.html'), '<h1 id="ready">Hi</h1>');
    for (const base of ['/nibfin-core/', '/alternate-docs/']) {
      const index = join(directory, 'index.html');
      const valid = `<a href="${base}article/#ready">Read</a>`;
      await writeFile(index, valid);
      await checkArticleLinks(base, directory);
      await writeFile(index, valid.replace('article/', 'missing/'));
      await assert.rejects(checkArticleLinks(base, directory), /ENOENT/);
      await writeFile(index, valid.replace('#ready', '#broken'));
      await assert.rejects(checkArticleLinks(base, directory), /Broken article fragment/);
      await writeFile(index, valid);
      await checkArticleLinks(base, directory);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
