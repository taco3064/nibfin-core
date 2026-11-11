import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const decode = (text) => text.replaceAll('&amp;', '&').replaceAll('&#39;', "'")
  .replaceAll('&quot;', '"');

// Resolve every generated article link, including same-page and cross-page fragments.
export async function checkArticleLinks(base, directory = 'website/dist') {
  const paths = (await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith('.html'));
  const html = new Map();
  for (const path of paths) html.set(path, await readFile(join(directory, path), 'utf8'));
  let checked = 0;
  for (const [path, text] of html) {
    const route = path.replace(/index\.html$/, '').replaceAll('\\', '/');
    const current = new URL(base + route, 'https://docs.invalid');
    for (const [, raw] of text.matchAll(/\shref="([^"]*)"/g)) {
      const target = new URL(decode(raw), current);
      if (target.origin !== current.origin) continue;
      assert(target.pathname.startsWith(base), `Article link outside base: ${raw}`);
      let local = decodeURIComponent(target.pathname.slice(base.length));
      if (!local || local.endsWith('/')) local += 'index.html';
      const full = join(directory, local);
      assert(!relative(directory, full).startsWith('..'), 'Link escapes output');
      assert((await stat(full)).isFile(), `Missing article target: ${raw}`);
      if (target.hash && local.endsWith('.html')) {
        const content = html.get(local);
        const ids = [...content.matchAll(/\sid="([^"]+)"/g)]
          .map((match) => decode(match[1]));
        assert(ids.includes(decodeURIComponent(target.hash.slice(1))),
          `Broken article fragment: ${raw} from ${path}`);
      }
      checked++;
    }
  }
  console.log(`Resolved ${checked} generated article links under ${base}`);
}
