import { repoPath } from './github-read.mjs';
import { digest, isSha, requireThat } from './identity.mjs';

// Current implementation is a provider observation, not a historical receipt.
export async function readCurrentMain(reader, issue) {
  const repository = await reader.repository(issue.repository);
  requireThat(repository.id === issue.repositoryId && repository.full_name === issue.repository &&
    repository.default_branch === 'main' && repository.private === false && !repository.archived && !repository.disabled,
  'CURRENT_MAIN_REPOSITORY_CHANGED');
  const path = `${repoPath(issue.repository)}/git/ref/heads/main`, ref = await reader.get(path);
  requireThat(ref.ref === 'refs/heads/main' && ref.object?.type === 'commit' && isSha(ref.object.sha), 'CURRENT_MAIN_UNAVAILABLE');
  requireThat(digest(await reader.get(path)) === digest(ref), 'MAIN_CHANGED_DURING_READ');
  return { repositoryId: repository.id, head: ref.object.sha, observationHash: digest({ repositoryId: repository.id, ref }) };
}
