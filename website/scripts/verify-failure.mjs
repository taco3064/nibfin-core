import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runNpm } from './process.mjs';

// Exercise the actual root entry in a disposable source copy. Dependencies
// resolve from the installed parent; the reviewed source is never mutated.
await mkdir(resolve('.npm'), { recursive: true });
const directory = await mkdtemp(resolve('.npm/website-propagation-'));
let cleanupSafe = true;
try {
  const excluded = /^(?:\.npm|node_modules|\.git|\.aws|\.codex|\.agents)$/;
  for (const entry of await readdir('.')) {
    if (excluded.test(entry)) continue;
    await cp(entry, join(directory, entry), { recursive: true,
      filter: (path) => !/(?:^|\/)(?:node_modules|\.astro|dist)(?:\/|$)/
        .test(path) });
  }
  await writeFile(join(directory, 'website/src/doc03-negative-control.tsx'),
    'const bad: number = "wrong";\n' +
    'export const Bad = () => <span>{bad}</span>;\n', { flag: 'wx' });
  const result = runNpm(['run', 'verify'], { timeout: 240000,
    cwd: directory,
    env: { ...process.env, NIBFIN_WEBSITE_PROPAGATION_CHILD: '1' } });
  assert.notEqual(result.status, 0, 'Root verify ignored invalid website source');
  assert.match(result.stdout + result.stderr, /doc03-negative-control\.tsx/,
    'Verify failed before reaching the website negative control');
  assert.match(result.stdout + result.stderr, /not assignable to type 'number'/,
    'Require the actual TypeScript diagnostic');
  console.log('Root verify propagated the website TypeScript failure.');
} catch (error) {
  cleanupSafe = error.terminationUnknown !== true;
  if (!cleanupSafe) console.error('Retained website control:', directory);
  throw error;
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
