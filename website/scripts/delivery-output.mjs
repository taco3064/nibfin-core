import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Check content links as well as the generated sidebar, at the actual build base.
export async function inspectDeliveryOutput(base, directory = 'website/dist') {
  for (const route of ['', 'architecture/', 'lifecycle/', 'security/',
    'limitations/']) {
    const html = await readFile(join(directory, route, 'index.html'), 'utf8');
    const origin = new URL(`https://example.org${base}${route}`);
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|data:)/.test(raw)) continue;
      const target = new URL(raw.replaceAll('&amp;', '&'), origin);
      assert(target.pathname.startsWith(base), `Outside base: ${raw}`);
      const path = decodeURIComponent(target.pathname.slice(base.length));
      assert(!path.startsWith(base.slice(1)), `Duplicate base: ${raw}`);
      const output = await readFile(join(directory,
        path.endsWith('/') || !path ? `${path}index.html` : path), 'utf8');
      if (target.hash && target.pathname.endsWith('/')) {
        const id = decodeURIComponent(target.hash.slice(1));
        assert(output.includes(`id="${id}"`), `Missing anchor: ${raw}`);
      }
    }
    if (!route) {
      for (const slug of ['architecture', 'lifecycle', 'security', 'limitations']) {
        assert(html.includes(`href="${base}${slug}/"`), `Missing link: ${slug}`);
      }
    }
  }
}
