import { isSha, requireThat } from './identity.mjs';

// Compare the observed merge to the provider's verified integration tree.
// Legacy same-base rewrites can still be checked against the original tree.
export async function readMergeIdentity(
  reader,
  root,
  { head, base, merge, testMerge },
  code,
) {
  const commit = await reader.get(`${root}/git/commits/${merge}`);
  requireThat(commit?.sha === merge && Array.isArray(commit.parents), code);
  if (testMerge) {
    const preview = await reader.get(root + '/git/commits/' + testMerge);
    requireThat(
      preview.sha === testMerge &&
        preview.parents?.length === 2 &&
        preview.parents[0].sha === base &&
        preview.parents[1].sha === head &&
        isSha(preview.tree?.sha) &&
        preview.tree.sha === commit.tree?.sha,
      code,
    );
  }
  if (commit.parents.length === 2) {
    requireThat(
      commit.parents[0].sha === base && commit.parents[1].sha === head,
      code,
    );
    return 'merge';
  }
  requireThat(
    commit.parents.length === 1 &&
      commit.parents[0].sha === base &&
      isSha(commit.tree?.sha),
    code,
  );
  if (testMerge) return 'rewrite';
  const original = await reader.get(`${root}/git/commits/${head}`);
  requireThat(
    original?.sha === head &&
      original.parents?.length === 1 &&
      original.parents[0].sha === base &&
      isSha(original.tree?.sha) &&
      original.tree.sha === commit.tree.sha,
    code,
  );
  return 'rewrite';
}
