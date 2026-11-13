import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const english = 'Nibfin helps people deliver changes through GitHub Issues,';

// Inspect Astro output, rather than maintaining a parallel route list.
export async function inspectOutput(base, directory = 'website/dist') {
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  assert(html.includes(english), 'Missing English index content');
  const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1]).filter((url) => url.startsWith('/'));
  for (const url of urls) {
    assert(url.startsWith(base), `URL outside selected base: ${url}`);
    const path = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]);
    assert(base === '/' || !path.startsWith(base.slice(1)),
      `Duplicate base: ${url}`);
    await readFile(join(directory, path.endsWith('/') || !path
      ? `${path}index.html` : path));
  }
  const emitted = (await readdir(directory, { recursive: true }))
    .map((path) => path.replaceAll('\\', '/'));
  assert(!emitted.includes('theme/index.html'), 'Theme fixture in public output');
  assert(!emitted.includes('does-not-exist-doc01/index.html'),
    'Missing route unexpectedly generated');
  const css = urls.find((url) => /\.css(?:\?|$)/.test(url));
  const js = urls.find((url) => /\.m?js(?:\?|$)/.test(url));
  assert(css && js, 'Index must reference CSS and JavaScript');
  const search = (await readdir(join(directory, 'pagefind'), { recursive: true }))
    .map((path) => path.replaceAll('\\', '/'));
  assert(search.includes('pagefind.js'), 'Missing Pagefind JavaScript');
  assert(search.some((name) => name.endsWith('.pf_meta')), 'Missing search index');
  assert(search.some((name) => name.endsWith('.pf_index')), 'Missing search shard');
  assert(search.some((name) => name.endsWith('.pf_fragment')),
    'Missing search fragment');
  assert(search.includes('wasm.en.pagefind'), 'Missing English search runtime');
  const chunks = emitted.filter((name) => name.startsWith('_astro/')
    && /\.(?:css|js)$/.test(name));
  const searchChunk = chunks.find((name) => name.startsWith('_astro/Search.'));
  if (searchChunk) {
    const js = await readFile(join(directory, searchChunk), 'utf8');
    assert(js.includes(`baseUrl:${JSON.stringify(base)}`),
      'Search base URL differs from selected base');
    assert(js.includes(`bundlePath:${JSON.stringify(base)}`),
      'Search bundle path differs from selected base');
  }
  return [...new Set(urls.filter((url) => /\.(?:css|m?js)(?:[?#]|$)/.test(url))),
    ...chunks.map((name) => `${base}${name}`),
    ...search.filter((name) => name.endsWith('.js'))
      .map((name) => `${base}pagefind/${name}`),
    ...search.filter((name) => /\.(?:pf_meta|pf_index|pf_fragment|pagefind)$/.test(name))
      .map((name) => `${base}pagefind/${name}`)];
}
