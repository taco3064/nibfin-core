import { digest, isDigest } from './identity.mjs';

// The binary Git diff includes the changed paths, modes and before/after bytes.
// The full Candidate still pins the exact checkout for hooks and publication.
export function candidateContentHash(candidate) {
  const { repository, repositoryId, issueId, diffHash, paths, obligations,
    artifacts, hookSources } = candidate;
  return digest({ repository, repositoryId, issueId, diffHash, paths, obligations,
    artifacts, hookSources });
}

export async function equivalentCandidate(store, candidate, hash) {
  if (!isDigest(hash) || !candidate) return false;
  if (hash === digest(candidate)) return true;
  const previous = await store.get(hash);
  return candidateContentHash(previous) === candidateContentHash(candidate);
}
