import { websiteFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runNpm } from './process.mjs';

const directory = await websiteFixture('nibfin-website-propagation-');
let cleanupSafe = true;
try {
  const { cp } = await import('node:fs/promises');
  for (const path of ['scripts', 'test']) {
    await cp(path, join(directory, path), { recursive: true });
  }
  const article = join(directory, 'website/src/content/docs/cli.mdx');
  const original = await readFile(article, 'utf8');
  await writeFile(article, original + '\n```sh\nfabricated command\n```\n');
  const docs = runNpm(['run', 'verify', '--',
    'website/src/content/docs/cli.mdx'], { timeout: 240000, cwd: directory });
  assert.notEqual(docs.status, 0, 'Root verify ignored documentation failure');
  assert.match(docs.stdout + docs.stderr, /Article audit changed/);
  await writeFile(article, original);
  await writeFile(join(directory, 'website/src/doc03-negative-control.tsx'),
    'const bad: number = "wrong";\n' +
    'export const Bad = () => <span>{bad}</span>;\n', { flag: 'wx' });
  const args = ['run', 'verify', '--', 'website/src/doc03-negative-control.tsx'];
  const result = runNpm(args, {
    timeout: 240000,
    cwd: directory,
    env: { ...process.env, NIBFIN_WEBSITE_PROPAGATION_CHILD: '1' } });
  assert.notEqual(result.status, 0, 'Root verify ignored invalid website source');
  assert.match(result.stdout + result.stderr, /doc03-negative-control\.tsx/,
    'Verify failed before reaching the website negative control');
  assert.match(result.stdout + result.stderr, /not assignable to type 'number'/,
    'Require the actual TypeScript diagnostic');
  console.log('Root verify propagated documentation and TypeScript failures.');
} catch (error) {
  cleanupSafe = error.terminationUnknown !== true;
  if (!cleanupSafe) console.error('Retained website control:', directory);
  throw error;
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
