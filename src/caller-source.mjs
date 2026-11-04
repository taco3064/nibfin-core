import { repoPath } from './github-read.mjs';
import { readPinnedFile } from './github-approval.mjs';
import { isSha, requireThat } from './identity.mjs';

// Ordinary delivery merges advance main, not the adopted workflow. Accept a
// descendant only after reading identical pinned caller bytes at both ends.
// This never changes installed Core, reusable workflow or approval source pins.
export async function readCallerSource(reader, repository, workflow, current) {
  requireThat(isSha(workflow.commit) && isSha(current), 'INVALID_CALLER_SOURCE');
  await readPinnedFile(reader, repository, workflow.path, workflow.commit, workflow.blob);
  if (current !== workflow.commit) {
    const ancestry = await reader.get(`${repoPath(repository)}/compare/${workflow.commit}...${current}`);
    requireThat(ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === workflow.commit,
      'CALLER_SOURCE_NOT_DESCENDANT');
    await readPinnedFile(reader, repository, workflow.path, current, workflow.blob);
    const change = async ref => {
      const values = await reader.get(`${repoPath(repository)}/commits?sha=${ref}&path=${encodeURIComponent(workflow.path)}&per_page=1`);
      requireThat(Array.isArray(values) && values.length === 1 && isSha(values[0].sha),
        'CALLER_HISTORY_UNAVAILABLE');
      return values[0].sha;
    };
    requireThat(await change(workflow.commit) === await change(current), 'CALLER_REVOKED_OR_SUPERSEDED');
  }
  return current;
}
