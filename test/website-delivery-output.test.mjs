import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDeliveryOutput } from '../website/scripts/delivery-output.mjs';

const routes = ['architecture', 'lifecycle', 'security', 'limitations'];
test('landing discovery resolves relative and base-prefixed guide links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-delivery-output-'));
  try {
    for (const route of routes) {
      await mkdir(join(directory, route));
      await writeFile(join(directory, route, 'index.html'), '<h1>Guide</h1>');
    }
    const index = join(directory, 'index.html');
    for (const base of ['/nibfin-core/', '/alternate-docs/']) {
      for (const prefix of ['', base]) {
        const home = routes.map((route) =>
          `<a href="${prefix}${route}/">Read ${route}</a>`).join('\n');
        await writeFile(index, home);
        await inspectDeliveryOutput(base, directory);
        await writeFile(index, home.replace(/<a[^>]+>Read lifecycle<\/a>/, ''));
        await assert.rejects(inspectDeliveryOutput(base, directory),
          /Missing link: lifecycle/);
        await writeFile(index, home.replace('security/', 'security/#missing'));
        await assert.rejects(inspectDeliveryOutput(base, directory), /Missing anchor/);
        await writeFile(index, home);
        await inspectDeliveryOutput(base, directory);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
