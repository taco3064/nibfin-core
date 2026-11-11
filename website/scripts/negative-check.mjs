import { websiteFixture } from './fixture.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runNpm } from './process.mjs';

const directory = await websiteFixture('nibfin-website-controls-');
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
  check();
  const bad = join(copy, 'src/doc03-bad.tsx');
  await writeFile(bad, 'const bad: number = "wrong";\n' +
    'export const Bad = () => <span>{bad}</span>;\n');
  check(/not assignable to type 'number'/);
  await rm(bad);
  check();
  const index = join(copy, 'src/content/docs/index.md');
  const content = await readFile(index, 'utf8');
  await writeFile(index, content.replace(/^title:.*\n/m, ''));
  const { digest } = await import('./source-claims.mjs');
  const auditPath = join(copy, 'evidence/checklist.json');
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  audit.pages['index.md'].sha256 = digest(await readFile(index));
  await writeFile(auditPath, JSON.stringify(audit));
  check(/title[\s\S]*(?:Required|required)/);
  await writeFile(index, content);
  audit.pages['index.md'].sha256 = digest(content);
  await writeFile(auditPath, JSON.stringify(audit));
  check();
  const navigation = join(copy, 'navigation.mjs');
  const sidebar = await readFile(navigation, 'utf8');
  await writeFile(navigation, sidebar.replace("'architecture'", "'does-not-exist'"));
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
