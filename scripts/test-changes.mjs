import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { websiteInput } from './cd-paths.mjs';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Git diff unavailable');
  return result.stdout;
}

function changedPaths(args) {
  const provided = args.filter(arg => !arg.startsWith('--'));
  if (provided.length) return provided;
  const common = ['--name-only', '--no-renames', '-z', '--'];
  if (!process.env.GITHUB_EVENT_PATH)
    return git(['diff', '--cached', ...common]).split('\0').filter(Boolean);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let base = event.pull_request?.base?.sha ?? event.before;
  if (base === '0'.repeat(40)) base = git(['merge-base', 'origin/main', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('CI diff base unavailable');
  return git(['diff', base, 'HEAD', ...common]).split('\0').filter(Boolean);
}

const projectFiles = /^(?:package(?:-lock)?\.json|\.node-version|\.npmrc)$/;
const controls = /^(?:\.github\/workflows\/ci\.yml|scripts\/test-changes\.mjs)$/;
const imageInputs = /^src\/security\//;
const windowsTests = new Set([
  'test/source-mode.test.mjs', 'test/mcp-source.test.mjs',
  'test/mcp-resolve.test.mjs', 'test/mcp-windows.test.mjs',
]);

const literals = /['"`]([^'"`\s]+)['"`]/g;
const sourcePath = /^(?:\.\.?\/|src\/|scripts\/|skills\/|website\/|bin\/|\.github\/)/;

function dependencies(file, changed, visited = new Set()) {
  if (changed.has(file)) return true;
  if (visited.has(file)) return false;
  visited.add(file);
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
  for (const match of content.matchAll(literals)) {
    const value = match[1];
    if (!sourcePath.test(value) || value.includes('$')) continue;
    const target = posix.normalize(value.startsWith('.')
      ? posix.join(posix.dirname(file), value) : value);
    if (target.startsWith('../')) continue;
    if (changed.has(target) || (/\.(?:mjs|cjs|js)$/.test(target) &&
      dependencies(target, changed, visited))) return true;
  }
  return false;
}

function selectedTests(paths, windows) {
  const changed = new Set(paths);
  const all = paths.some(path => projectFiles.test(path) || controls.test(path));
  const skills = paths.some(path => path.startsWith('skills/'));
  const image = paths.some(path => imageInputs.test(path));
  return readdirSync('test').filter(name => name.endsWith('.test.mjs'))
    .map(name => `test/${name}`)
    .filter(file => (!windows || windowsTests.has(file)) &&
      (all || (skills && /(?:approval|agent|plan|package|stage|skills)/.test(file)) ||
        (image && /(?:sandbox|backend|environment|process|profile)/.test(file)) ||
        dependencies(file, changed)));
}

function run(executable, args) {
  const child = spawnSync(executable, args, { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

const args = process.argv.slice(2);
const paths = changedPaths(args);
const website = paths.some(path => websiteInput(path) || controls.test(path) ||
  path === 'test/cd-workflow.test.mjs');
if (args.includes('--native-docker')) {
  const changed = new Set(paths);
  const docker = paths.some(path => controls.test(path) || imageInputs.test(path) ||
    path === '.github/actions/native-docker/action.yml') ||
    ['scripts/verify-live-adapter.mjs', 'scripts/verify-live-hooks.mjs',
      'scripts/verify-live-codex.mjs'].some(path => dependencies(path, changed));
  const line = `native_docker=${docker}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
} else if (args.includes('--website')) {
  const line = `website=${website}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
} else {
  const tests = selectedTests(paths, args.includes('--windows'));
  if (args.includes('--list')) {
    if (tests.length) process.stdout.write(tests.join('\n') + '\n');
    process.exit(0);
  }
  const verify = args.includes('--verify');
  const npm = script => run(process.execPath, [process.env.npm_execpath, 'run', script]);
  if (verify && website) npm('website:check');
  if (verify && paths.some(path => /\.[cm]?js$/.test(path) || projectFiles.test(path)))
    run(process.execPath, ['scripts/check.mjs']);
  console.log(`Selected ${tests.length} test files for ${paths.length} changed paths.`);
  if (tests.length) run(process.execPath, ['--test', '--test-concurrency=2', ...tests]);
  if (verify && website) npm('website:ci');
}
