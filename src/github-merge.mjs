import { isSha, requireThat } from './identity.mjs';

// A rewritten single commit is accepted only with the same full tree and the
// same immediate base. Multi-commit rewrites require a separate adapter.
export async function readMergeIdentity(reader, root, { head, base, merge }, code) {
  const commit = await reader.get(`${root}/git/commits/${merge}`);
  requireThat(commit?.sha === merge && Array.isArray(commit.parents), code);
  if (commit.parents.length === 2) {
    requireThat(commit.parents[0].sha === base && commit.parents[1].sha === head, code);
    return 'merge';
  }
  requireThat(commit.parents.length === 1 && commit.parents[0].sha === base && isSha(commit.tree?.sha), code);
  const original = await reader.get(`${root}/git/commits/${head}`);
  requireThat(original?.sha === head && original.parents?.length === 1 && original.parents[0].sha === base &&
    isSha(original.tree?.sha) && original.tree.sha === commit.tree.sha, code);
  return 'rewrite';
}
