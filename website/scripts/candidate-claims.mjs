import assert from 'node:assert/strict';

// Candidate interfaces are not release or installed-operation evidence.
export function checkCandidateInventory(checklist, pages) {
  const candidate = checklist.candidateCli;
  assert.equal(candidate.status, 'Unverified', 'Candidate availability changed');
  assert.equal(candidate.release, null, 'Candidate cannot certify a release');
  const seen = new Set();
  for (const entry of candidate.commands) {
    assert(!seen.has(entry.command), 'Duplicate candidate command');
    seen.add(entry.command);
    assert(['candidate', 'managed', 'legacy/manual'].includes(entry.route),
      'Invalid candidate route');
    assert(entry.pages.length > 0 && entry.pages.every(page => pages.includes(page)),
      'Candidate command names an unaudited page');
    const selections = entry.command.matchAll(/--agent(?:=|\s+)(\S+)/g);
    for (const [, agent] of selections) {
      assert.equal(candidate.providers[agent], 'Unverified',
        'Unavailable provider command must be withheld');
    }
  }
  for (const claim of checklist.claims) {
    if (!claim.provider) continue;
    assert.equal(claim.status, candidate.providers[claim.provider],
      'Provider availability differs from inventory');
  }
}
