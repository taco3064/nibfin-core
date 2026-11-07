import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectOutput, english } from '../website/scripts/output.mjs';

test('static inspection rejects invalid paths and missing assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'website-output-'));
  const base = '/docs/';
  const html = (prefix) => `${english}<link href="${prefix}style.css">` +
    `<script src="${prefix}app.js"></script><a href="${prefix}">Home</a>`;
  try {
    await mkdir(join(directory, 'pagefind'));
    await mkdir(join(directory, 'pagefind/index'));
    await mkdir(join(directory, 'pagefind/fragment'));
    for (const path of ['style.css', 'app.js', 'pagefind/pagefind.js',
      'pagefind/en.pf_meta', 'pagefind/index/en.pf_index',
      'pagefind/fragment/en.pf_fragment', 'pagefind/wasm.en.pagefind']) {
      await writeFile(join(directory, path), 'fixture');
    }
    await writeFile(join(directory, 'index.html'), html(base));
    const resources = await inspectOutput(base, directory);
    assert(resources.includes(`${base}pagefind/index/en.pf_index`));
    assert(resources.includes(`${base}pagefind/fragment/en.pf_fragment`));
    assert(resources.includes(`${base}pagefind/wasm.en.pagefind`));
    await writeFile(join(directory, 'index.html'), html('/'));
    await assert.rejects(inspectOutput(base, directory), /outside selected base/);
    await writeFile(join(directory, 'index.html'), html('/docs/docs/'));
    await assert.rejects(inspectOutput(base, directory), /Duplicate base/);
    await writeFile(join(directory, 'index.html'), html(base));
    await rm(join(directory, 'app.js'));
    await assert.rejects(inspectOutput(base, directory), /ENOENT/);
    await writeFile(join(directory, 'app.js'), 'fixture');
    await rm(join(directory, 'pagefind/en.pf_meta'));
    await assert.rejects(inspectOutput(base, directory), /Missing search index/);
    await writeFile(join(directory, 'pagefind/en.pf_meta'), 'fixture');
    await rm(join(directory, 'pagefind/index/en.pf_index'));
    await assert.rejects(inspectOutput(base, directory), /Missing search shard/);
    await writeFile(join(directory, 'pagefind/index/en.pf_index'), 'fixture');
    await writeFile(join(directory, 'index.html'), html('/'));
    await inspectOutput('/', directory);
    await mkdir(join(directory, 'does-not-exist-doc01'));
    await writeFile(join(directory, 'does-not-exist-doc01/index.html'), english);
    await assert.rejects(inspectOutput('/', directory), /Missing route/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
