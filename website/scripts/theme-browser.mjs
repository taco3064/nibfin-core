import { inspectIslandOutput } from './island-output.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpm } from './process.mjs';

const directory = await mkdtemp(join(tmpdir(), 'nibfin-theme-browser-'));
let cleanupSafe = true;
try {
  for (const base of ['/nibfin-core/', '/alternate-docs/']) {
    const env = { ...process.env, WEBSITE_BASE: base,
      NIBFIN_THEME_OUTPUT: directory, NIBFIN_THEME_FIXTURE: '1' };
    assert.equal(runNpm(['run', 'website:build'], { env }).status, 0);
    await inspectIslandOutput();
    assert.equal(runNpm(['exec', '--', 'playwright', 'test',
      '--config', 'website/playwright.config.mjs', ...process.argv.slice(2)],
    { env, timeout: 240000 }).status, 0, `Rendered theme checks failed: ${base}`);
  }
} catch (error) {
  cleanupSafe = error.terminationUnknown !== true;
  if (!cleanupSafe) console.error('Retained browser diagnostics:', directory);
  throw error;
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
