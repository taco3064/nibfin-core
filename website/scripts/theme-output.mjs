import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function inspectThemeOutput(base, directory = 'website/dist') {
  const files = await readdir(join(directory, '_astro'));
  const css = (await Promise.all(files.filter((file) => file.endsWith('.css'))
    .map((file) => readFile(join(directory, '_astro', file), 'utf8')))).join('\n');
  const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)]
    .map((match) => match[1].replaceAll(/["']/g, ''));
  assert.equal(new Set(fonts).size, 2, 'Both fonts must be emitted');
  for (const url of fonts) {
    assert(url.startsWith(`${base}_astro/`), `Font outside base: ${url}`);
    const bytes = await readFile(join(directory, url.slice(base.length)));
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2', `Bad font: ${url}`);
  }
  for (const name of ['bg-background', 'text-foreground', 'bg-primary',
    'text-primary-foreground', 'border-border', 'outline-ring']) {
    assert(css.includes(name), `Built utility missing: ${name}`);
  }
  const html = await readFile(join(directory, 'theme/index.html'), 'utf8');
  assert(html.includes('data-consumer'), 'Missing real Astro utility consumer');
  return fonts;
}
