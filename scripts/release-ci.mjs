import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitHubReader, repoPath } from '../src/github-read.mjs';
import { packageSource } from '../src/source-package.mjs';
import { planRelease, ReleaseDraft } from '../src/release.mjs';
import { command } from '../src/process.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest, isId, isSha, requireThat } from '../src/identity.mjs';

async function main() {
  const env = process.env, repository = 'taco3064/nibfin-core', commit = env.GITHUB_SHA;
  requireThat(env.GITHUB_REPOSITORY === repository && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' && isSha(commit) && isId(Number(env.GITHUB_RUN_ID)) &&
    isId(Number(env.GITHUB_RUN_ATTEMPT)) && ['true', 'false'].includes(env.CREATE_DRAFT), 'UNTRUSTED_RELEASE_INVOCATION');
  const pkg = JSON.parse((await command('/usr/bin/git', ['show', `${commit}:package.json`], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' },
  })).stdout);
  requireThat(env.RELEASE_VERSION === `v${pkg.version}`, 'RELEASE_PACKAGE_VERSION_MISMATCH');
  const reader = new GitHubReader(env.GH_TOKEN), root = repoPath(repository);
  const built = await packageSource(process.cwd(), commit);
  const plan = await planRelease(reader, { version: env.RELEASE_VERSION, built });
  const admit = async () => {
    const repo = await reader.repository(repository), branch = await reader.get(`${root}/branches/main`);
    const run = await reader.get(`${root}/actions/runs/${env.GITHUB_RUN_ID}`);
    requireThat(repo.id === plan.repositoryId && repo.private === false && branch.protected === true && branch.commit?.sha === commit &&
      run.repository?.id === repo.id && run.head_repository?.id === repo.id && run.head_sha === commit &&
      run.path === '.github/workflows/release.yml' && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
      run.status === 'in_progress' && run.run_attempt === Number(env.GITHUB_RUN_ATTEMPT) &&
      run.actor?.id === Number(env.GITHUB_ACTOR_ID) && run.triggering_actor?.id === run.actor.id, 'RELEASE_RUN_OR_SOURCE_CHANGED');
    const permission = await reader.get(`${root}/collaborators/${encodeURIComponent(run.actor.login)}/permission`);
    requireThat(permission.user?.id === run.actor.id && ['admin', 'maintain', 'write'].includes(permission.permission), 'RELEASE_ACTOR_REVOKED');
    return digest(plan);
  };
  await admit();
  let result = { status: 'planned', published: false, plan };
  if (env.CREATE_DRAFT === 'true') {
    requireThat(pkg.version !== '0.0.0', 'DEVELOPMENT_VERSION_NOT_RELEASABLE');
    const state = join(env.RUNNER_TEMP, 'nibfin-release'); await mkdir(state, { mode: 0o700 });
    result = await new ReleaseDraft({ reader, token: env.GH_TOKEN, admit,
      journal: new OperationJournal(state, { repositoryId: plan.repositoryId, id: `release-${plan.version}` }) }).create(plan, built);
    if (result.status !== 'draft-created') process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `Core release preparation: **${result.status}**. No release was published.\n\nSource: \`${commit}\`\nArchive: \`${built.sha256}\`\n`);
}
main().catch(() => { process.stderr.write('Release preparation refused; no automatic retry is permitted.\n'); process.exitCode = 1; });
