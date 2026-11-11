import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Evidence is supplied independently of a claim. Fixtures never certify publication.
export function compareClaim(claim, evidence, { fixture = false } = {}) {
  assert(['Released', 'Installed', 'Unverified', 'Planned', 'Unsupported']
    .includes(claim.status), 'Invalid availability status');
  if (['Unverified', 'Planned'].includes(claim.status)) {
    assert(!claim.command, 'Unavailable/planned command must be withheld');
    return;
  }
  assert(evidence?.source, 'Required source unavailable');
  assert.equal(claim.repository, evidence.repository, 'Repository mismatch');
  assert.match(evidence.commit, /^[a-f0-9]{40}$/, 'Immutable identity required');
  assert.equal(claim.commit, evidence.commit, 'Identity mismatch');
  assert.equal(digest(evidence.source), evidence.sha256, 'Source digest mismatch');
  assert.equal(claim.version, evidence.version, 'Version mismatch');
  assert(evidence.source.includes(evidence.help), 'Help/source mismatch');
  assert(evidence.help.split('\n').includes(claim.command), 'Command/help mismatch');
  if (claim.status === 'Released') {
    assert(!evidence.candidate, 'Candidate cannot be represented as a release');
    assert(fixture || evidence.provenance === 'public-readback',
      'Real release requires public read-back');
    const release = evidence.release;
    assert(release && !release.draft && !release.prerelease,
      'Release unavailable or not formal');
    assert.equal(release.commit, evidence.commit, 'Release identity mismatch');
    assert.equal(release.tag, claim.version, 'Release version mismatch');
    assert(claim.assets.length > 0, 'Required assets must be specified');
    for (const name of claim.assets) {
      const asset = release.assets.find((asset) => asset.name === name);
      assert(asset?.bytes, 'Required asset unavailable');
      assert.equal(digest(asset.bytes), asset.sha256, 'Asset mismatch');
    }
  } else if (claim.status === 'Installed') {
    assert(evidence.installation?.configuration, 'Installed configuration required');
    assert.equal(evidence.installation.commit, claim.commit, 'Installed mismatch');
  } else {
    assert(evidence.unsupported?.includes(claim.command),
      'Unsupported requires observed rejection');
  }
}
