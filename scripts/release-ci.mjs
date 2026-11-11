import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitHubReader, repoPath } from '../src/github-read.mjs';
import { packageSource } from '../src/source-package.mjs';
import { planRelease, ReleaseDraft } from '../src/release.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest, requireThat } from '../src/identity.mjs';

async function main() {
  const env = process.env;
  const repository = 'taco3064/nibfin-core';
  const version = env.GITHUB_REF_NAME;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  requireThat(env.GITHUB_REPOSITORY === repository && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === `refs/tags/${version}` && env.GITHUB_REF_PROTECTED === 'true' &&
    event.created === true && !event.deleted && !event.forced,
  'UNTRUSTED_RELEASE_INVOCATION');

  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  requireThat(version === `v${pkg.version}` && pkg.version !== '0.0.0',
    'RELEASE_PACKAGE_VERSION_MISMATCH');
  const reader = new GitHubReader(env.GH_TOKEN);
  const root = repoPath(repository);
  const built = await packageSource(process.cwd(), env.SOURCE_COMMIT);
  const plan = await planRelease(reader, { version, built });
  const admit = async () => {
    const actor = encodeURIComponent(env.GITHUB_ACTOR);
    const permission = await reader.get(`${root}/collaborators/${actor}/permission`);
    requireThat(permission.user?.id === Number(env.GITHUB_ACTOR_ID) &&
      ['admin', 'maintain', 'write'].includes(permission.permission),
    'RELEASE_ACTOR_REVOKED');
    return digest(plan);
  };
  const state = join(env.RUNNER_TEMP, 'nibfin-release');
  await mkdir(state, { mode: 0o700 });
  const journal = new OperationJournal(state, {
    repositoryId: plan.repositoryId, id: `release-${version}`,
  });
  const result = await new ReleaseDraft({
    reader, token: env.GH_TOKEN, admit, journal,
  }).create(plan, built);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'draft-created') process.exitCode = 1;
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `Core release draft: **${result.status}**\n\nSource: ${plan.commit}\n`);
  }
}

main().catch((error) => {
  const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'RELEASE_DRAFT_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
