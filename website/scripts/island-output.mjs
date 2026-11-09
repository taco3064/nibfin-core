import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function decode(value) {
  return value.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) =>
    String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)))
    .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export async function inspectIslandOutput(directory = 'website/dist') {
  const chunks = await readdir(join(directory, '_astro'));
  const css = (await Promise.all(chunks.filter((name) => name.endsWith('.css'))
    .map((name) => readFile(join(directory, '_astro', name), 'utf8')))).join('\n');
  assert(css.includes('disabled\\:cursor-not-allowed'),
    'Missing utility discovered only in the React primitive');
  const html = await readFile(join(directory, 'theme/index.html'), 'utf8');
  const islands = [...html.matchAll(/<astro-island\b[^>]*>[\s\S]*?<\/astro-island>/g)]
    .map((match) => match[0]);
  assert.equal(islands.length, 1, 'Only the bounded interaction is an island');
  const island = islands[0];
  assert.match(island, /component-url="[^"]*\/CopyExample\./);
  assert.match(island, /renderer-url="[^"]*\/client\./);
  assert.match(island, /\bssr client="load"/);
  assert.match(island, /<button[^>]*disabled=""/);
  assert.match(island, /Copy reading example<\/button>/);
  const props = JSON.parse(decode(island.match(/ props="([^"]+)"/)[1]));
  const pre = html.match(/<pre data-language="ts">([\s\S]*?)<\/pre>/)[1];
  const lines = [...pre.matchAll(/<div class="code">([\s\S]*?)<\/div>/g)]
    .map((match) => decode(match[1].replace(/<[^>]*>/g, '')));
  assert.equal(lines.join('\n'), props.text[1], 'SSR sample and island props differ');
  assert(!island.includes('<pre'), 'Sample must remain outside the React island');
  assert(html.includes('not an installation command.'), 'Missing example boundary');
  console.log('Bounded SSR island, official renderer and example props passed.');
  return props.text[1];
}
