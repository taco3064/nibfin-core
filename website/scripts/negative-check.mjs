import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runNpm } from './process.mjs';

// Keep the disposable workspace beneath the installed root for dependency lookup.
await mkdir(resolve('.npm'), { recursive: true });
const directory = await mkdtemp(resolve('.npm/website-controls-'));
const copy = join(directory, 'website');
function check(expected) {
  const result = runNpm(['run', 'check', '--prefix', copy]);
  if (expected) {
    assert.notEqual(result.status, 0, 'Negative control unexpectedly passed');
    assert.match(result.stdout + result.stderr, expected);
  } else assert.equal(result.status, 0, 'Restored website must pass');
}
let cleanupSafe = true;
try {
  await cp('website', copy, { recursive: true,
    filter: (path) => !/(?:^|\/)(?:dist|\.astro|node_modules)(?:\/|$)/.test(path) });
  check();
  const bad = join(copy, 'src/doc01-bad.ts');
  await writeFile(bad, 'const bad: number = "wrong";\n');
  check(/not assignable to type 'number'/);
  await rm(bad);
  check();
  const index = join(copy, 'src/content/docs/index.md');
  const content = await readFile(index, 'utf8');
  await writeFile(index, content.replace(/^title:.*\n/m, ''));
  check(/title[\s\S]*(?:Required|required)/);
  await writeFile(index, content);
  check();
  const navigation = join(copy, 'navigation.mjs');
  const sidebar = await readFile(navigation, 'utf8');
  await writeFile(navigation, sidebar.replace("'index'", "'does-not-exist'"));
  check(/(?:Navigation target|does-not-exist)/);
  await writeFile(navigation, sidebar);
  check();
} catch (error) {
  cleanupSafe = error.terminationUnknown !== true;
  if (!cleanupSafe) console.error('Retained negative-control source:', directory);
  throw error;
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
