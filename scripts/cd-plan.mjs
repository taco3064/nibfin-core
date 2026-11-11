import { appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { GitHubReader, repoPath } from '../src/github-read.mjs';
import { cdPaths } from './cd-paths.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_EVENT_NAME } = process.env;
const reader = new GitHubReader(GH_TOKEN);
const root = repoPath(GITHUB_REPOSITORY);
const manual = GITHUB_EVENT_NAME === 'workflow_dispatch';
const checkout = process.env.CD_SOURCE;
let routes = { core: true, website: true };
if (manual) {
  const docsOnly = process.env.CD_DOCS_ONLY === 'true';
  routes = { core: !docsOnly, website: docsOnly };
} else {
  // Only successful automatic runs use this name. A missing baseline rebuilds both.
  const history = await reader.get(root + '/actions/workflows/cd.yml/runs?' +
    'event=workflow_run&branch=main&status=success&per_page=20');
  for (const run of history.workflow_runs) {
    const previous = /^Main CD ([a-f0-9]{40})$/.exec(run.display_title)?.[1];
    if (!previous) continue;
    const ancestor = spawnSync('git', [
      'merge-base', '--is-ancestor', previous, checkout,
    ]);
    if (ancestor.error) throw ancestor.error;
    if (ancestor.status !== 0) continue;
    const diff = spawnSync('git', [
      'diff', '--name-only', '--no-renames', '-z', previous, checkout, '--',
    ], { encoding: 'utf8' });
    if (diff.error) throw diff.error;
    if (diff.status !== 0) throw new Error('Could not inspect main changes');
    const commit = spawnSync('git', ['log', '-1', '--format=%s', checkout], {
      encoding: 'utf8',
    });
    if (commit.error) throw commit.error;
    if (commit.status !== 0) throw new Error('Could not read main commit subject');
    routes = cdPaths(diff.stdout.split('\0').filter(Boolean), commit.stdout.trim());
    break;
  }
}

if (routes.website) {
  try {
    const site = await reader.get(root + '/pages');
    const environment = await reader.get(root + '/environments/github-pages');
    routes.website = site.build_type === 'workflow' &&
      environment.name === 'github-pages';
  } catch (error) {
    if (error.status !== 404) throw error;
    routes.website = false;
  }
  if (!routes.website) {
    const reason = 'Set Pages Source to GitHub Actions and configure github-pages.';
    if (manual) throw new Error(reason);
    console.log(`Docs deployment skipped. ${reason}`);
  }
}

await appendFile(GITHUB_OUTPUT, `core=${routes.core}\nwebsite=${routes.website}\n`);
