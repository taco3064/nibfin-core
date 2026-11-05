import { readFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { requireThat } from '../src/identity.mjs';

const source = /\.(?:mjs|cjs|js|json|ya?ml)$/;
const configuration = /\.(?:json|ya?ml)$/i;
const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  requireThat(result.status === 0, 'SOURCE_DIFF_UNAVAILABLE');
  return result.stdout;
};

export function sourceLimits(path, text) {
  if (configuration.test(path)) return;
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  requireThat(lines.length <= 1000, `SOURCE_FILE_LIMIT: ${path}`);
  for (const [index, line] of lines.entries()) {
    requireThat([...line].length <= 90, `SOURCE_LINE_LIMIT: ${path}:${index + 1}`);
  }
}

// Native CI event supplies the actual PR base/push-before SHA. Local checks use
// the current main merge-base, plus untracked and uncommitted program sources.
export async function checkChangedSourceLimits(env = process.env) {
  let base;
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    base = event.pull_request?.base?.sha ?? event.before;
  }
  if (!base || base === '0'.repeat(40)) {
    base = git(['merge-base', 'HEAD', 'origin/main']).trim();
  }
  requireThat(/^[a-f0-9]{40}$/.test(base), 'SOURCE_BASE_UNAVAILABLE');
  const paths = new Set(
    [
      ...git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base]).split('\0'),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
    ].filter((path) => source.test(path)),
  );
  for (const path of paths) {
    const stat = await lstat(path);
    requireThat(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_SOURCE_FILE');
    sourceLimits(path, await readFile(path, 'utf8'));
  }
  console.log(`Changed files inspected for applicable source limits: ${paths.size}.`);
}
