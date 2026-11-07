import { repoPath } from './github-read.mjs';
import { readPinnedFile } from './github-approval.mjs';
import { isSha, requireThat } from './identity.mjs';
import { callerRecipe } from './caller-recipes.mjs';

// Arbitrary callers require their exact adopted commit. Only a complete fixed,
// codeless Core recipe may run at a descendant with unchanged file history.
// Installed Core, reusable workflow and approval source pins never advance here.
export async function readCallerSource(reader, repository, workflow, current, recipe) {
  await readCallerContinuity(reader, repository, workflow, current);
  if (current !== workflow.commit || recipe?.kind === 'action-wake') {
    requireThat(recipe, 'CALLER_EXACT_COMMIT_REQUIRED');
    const source = await readPinnedFile(
      reader,
      repository,
      workflow.path,
      workflow.commit,
      workflow.blob,
    );
    const kinds = recipe.kind === 'action-wake'
      ? ['action-wake', 'action-dispatch']
      : [recipe.kind];
    const normalized = source.replaceAll('\r\n', '\n');
    requireThat(kinds.some(kind =>
      normalized === callerRecipe(kind, recipe.coreCommit, recipe)),
    'CALLER_NOT_FIXED_RECIPE');
  }
  return current;
}

// Revocation check for the current default branch. This does not authorize code
// from that branch to run in an already authenticated, pinned older Actions job.
export async function readCallerContinuity(reader, repository, workflow, current) {
  requireThat(isSha(workflow.commit) && isSha(current), 'INVALID_CALLER_SOURCE');
  await readPinnedFile(reader, repository, workflow.path, workflow.commit, workflow.blob);
  if (current !== workflow.commit) {
    const ancestry = await reader.get(
      `${repoPath(repository)}/compare/${workflow.commit}...${current}`,
    );
    requireThat(
      ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === workflow.commit,
      'CALLER_SOURCE_NOT_DESCENDANT',
    );
    await readPinnedFile(reader, repository, workflow.path, current, workflow.blob);
    const change = async (ref) => {
      const root = repoPath(repository),
        path = encodeURIComponent(workflow.path);
      const values = await reader.get(
        `${root}/commits?sha=${ref}&path=${path}&per_page=1`,
      );
      requireThat(
        Array.isArray(values) && values.length === 1 && isSha(values[0].sha),
        'CALLER_HISTORY_UNAVAILABLE',
      );
      return values[0].sha;
    };
    requireThat(
      (await change(workflow.commit)) === (await change(current)),
      'CALLER_REVOKED_OR_SUPERSEDED',
    );
  }
  return current;
}
