import { websiteFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNpm } from './process.mjs';
import { inspectIslandOutput } from './island-output.mjs';

const directory = await websiteFixture('nibfin-island-controls-');
let cleanupSafe = true;
try {
  const content = join(directory, 'website/src/lib/reading-example.ts');
  const original = await readFile(content, 'utf8');
  await writeFile(content, original.replace('console.log(message);',
    'console.log(message, "content change control");'));
  const buildEnv = { ...process.env, WEBSITE_BASE: '/nibfin-core/' };
  assert.equal(runNpm(['run', 'website:build'],
    { cwd: directory, env: buildEnv }).status, 0);
  const text = await inspectIslandOutput(join(directory, 'website/dist'));
  assert(text.includes('content change control'), 'Content mutation was not rendered');
  if (process.env.CI === 'true' || process.argv.includes('--browser')) {
    const env = { ...process.env, WEBSITE_BASE: '/nibfin-core/',
      NIBFIN_THEME_OUTPUT: join(directory, 'browser-output') };
    const args = ['exec', '--', 'playwright', 'test', '--config',
      'website/playwright.config.mjs', '--grep',
      'copy the actual displayed example with keyboard activation'];
    assert.equal(runNpm(args, { cwd: directory, env }).status, 0,
      'Changed content did not copy exactly as displayed');
    // Break a real island assertion in the disposable maintained test copy.
    const spec = join(directory, 'website/tests/copy-example.spec.mjs');
    const test = await readFile(spec, 'utf8');
    await writeFile(spec, test.replace("toHaveText('Example copied.')",
      "toHaveText('deliberately broken island assertion')"));
    const failed = runNpm(['run', 'website:browser', '--', '--grep',
      'copy the actual displayed example with keyboard activation'],
    { cwd: directory, env });
    assert.notEqual(failed.status, 0, 'Broken island assertion unexpectedly passed');
    assert.match(failed.stdout + failed.stderr, /deliberately broken island assertion/);
    await writeFile(spec, test);
    console.log('Content change and failing browser assertion controls passed.');
  } else {
    console.log('Changed SSR content passed; browser control Unverified.');
  }
} catch (error) {
  cleanupSafe = error.terminationUnknown !== true;
  if (!cleanupSafe) console.error('Retained island control:', directory);
  throw error;
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
