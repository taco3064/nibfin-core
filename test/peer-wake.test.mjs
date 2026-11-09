import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptedWake } from '../src/issue-wake.mjs';

const source = { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40) };
const local = {
  approvalPin: { repository: 'taco3064/nibfin-core', repositoryId: 11, source },
};
const peer = {
  approvalPin: { repository: 'taco3064/gh-nibfin', repositoryId: 22, source },
  workflow: { id: 3 },
};
const adoption = { coreCommit: source.commit, issues: [], repository: local };

test('native peer wake uses the peer repository policy and workflow', () => {
  const issue = { repository: 'taco3064/gh-nibfin', repositoryId: 22,
    id: 'I_peer', number: 4 };
  assert.deepEqual(adoptedWake(adoption, issue, [peer]), {
    ...peer,
    approvalPin: { ...peer.approvalPin, issueId: issue.id, issueNumber: issue.number },
  });
  assert.throws(() => adoptedWake(adoption, issue), /WAKE_ISSUE_NOT_ADOPTED/);
  assert.throws(() => adoptedWake(adoption, { ...issue, repositoryId: 11 }, [peer]),
    /WAKE_ISSUE_NOT_ADOPTED/);
  const stale = structuredClone(peer);
  stale.approvalPin.source.commit = 'b'.repeat(40);
  assert.throws(() => adoptedWake(adoption, issue, [stale]), /WAKE_SOURCE_CHANGED/);
});
