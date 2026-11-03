import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Check syntax without importing or executing project modules.
async function modules(directory, optional = false) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unsupported symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await modules(path));
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

try {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const version = (await readFile('.node-version', 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Node version must be exact');
  assert.equal(pkg.type, 'module', 'ES modules are required');
  assert.equal(pkg.engines.node, version, 'Runtime pins must agree');
  assert.equal(process.versions.node, version, 'Use the pinned Node version');
  const files = [];
  for (const directory of ['scripts', 'test', 'src', 'bin']) {
    const found = await modules(directory, ['src', 'bin'].includes(directory));
    if (['scripts', 'test'].includes(directory)) {
      assert(found.length > 0, `No JavaScript modules in ${directory}`);
    }
    files.push(...found);
  }
  assert(files.some(file => /\.test\.mjs$/.test(file)), 'No tests discovered');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Syntax check failed: ${file}`);
  }
  console.log(`Syntax checked ${files.length} JavaScript modules.`);
} catch (error) {
  console.error(`Check failed: ${error.message}`);
  process.exitCode = 1;
}
