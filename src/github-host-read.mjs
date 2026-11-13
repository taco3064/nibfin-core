import { command } from './process.mjs';
import { repoPath } from './github-read.mjs';
import { isSha, requireThat } from './identity.mjs';

const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };

export async function gitMain(repository, run = command) {
  repoPath(repository);
  const { stdout } = await run('/usr/bin/git', [
    'ls-remote', '--exit-code', `https://github.com/${repository}.git`,
    'refs/heads/main',
  ], {
    env: { ...env, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    cwd: '/', timeout: 15000,
  });
  const match = /^([a-f0-9]{40})\trefs\/heads\/main\n?$/.exec(stdout.toString());
  requireThat(match, 'CURRENT_MAIN_UNAVAILABLE');
  return match[1];
}

// One read-only GraphQL operation supplies repository metadata and main.
export async function ghQuery(repository, token, query, variables = {}, run = command) {
  repoPath(repository);
  const [owner, name] = repository.split('/');
  const { stdout } = await run('/usr/bin/gh', [
    'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, ...Object.entries(variables).flatMap(([key, value]) =>
      ['-F', `${key}=${value}`]),
  ], {
    env: { ...env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1',
      HOME: '/nonexistent', GH_CONFIG_DIR: '/nonexistent' },
    cwd: '/', timeout: 15000,
  });
  const result = JSON.parse(stdout.toString());
  requireThat(!result.errors?.length && result.data?.repository,
    'GITHUB_GRAPHQL_OBSERVATION_UNAVAILABLE');
  return result.data.repository;
}

export function repositoryMetadata(repo) {
  return { id: repo.databaseId, full_name: repo.nameWithOwner,
    default_branch: repo.defaultBranchRef?.name, private: repo.isPrivate,
    archived: repo.isArchived, disabled: repo.isDisabled };
}

export async function ghMain(repository, token, run = command) {
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      databaseId nameWithOwner isPrivate isArchived isDisabled
      defaultBranchRef { name target { __typename oid } }
    }
  }`;
  const repo = await ghQuery(repository, token, query, {}, run);
  const branch = repo?.defaultBranchRef;
  requireThat(branch?.target?.__typename === 'Commit' &&
    isSha(branch.target.oid) && typeof repo.isPrivate === 'boolean' &&
    typeof repo.isArchived === 'boolean' && typeof repo.isDisabled === 'boolean',
  'CURRENT_MAIN_UNAVAILABLE');
  return {
    repository: repositoryMetadata(repo),
    head: branch.target.oid,
  };
}

export function hostMainReader(token, run = command) {
  return async repository => {
    const head = await gitMain(repository, run).catch(() => null);
    return head ? { head } : ghMain(repository, token, run).catch(() => undefined);
  };
}
