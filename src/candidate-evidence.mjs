import { isDeepStrictEqual } from 'node:util';

export function enforcementPaths(paths) {
  return paths.filter(path =>
    path.startsWith('.nibfin/') || path.startsWith('.github/workflows/') ||
    ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(path));
}

function candidateContent(candidate) {
  const { base, tree, changes, diffHash, ...content } = candidate;
  return content;
}

export function sameCandidate(left, right) {
  return left.base === right.base && left.tree === right.tree &&
    (left.changes === undefined || right.changes === undefined ||
      left.changes === right.changes) &&
    isDeepStrictEqual(candidateContent(left), candidateContent(right));
}

// Native Git change records describe affected paths, modes and objects.
export function sameCandidateChanges(left, right) {
  return sameCandidate(left, right) ||
    (typeof left.changes === 'string' && left.changes === right.changes &&
      isDeepStrictEqual(candidateContent(left), candidateContent(right)));
}

export async function equivalentCandidate(store, candidate, reference) {
  return Boolean(reference && candidate &&
    sameCandidateChanges(await store.get(reference), candidate));
}
