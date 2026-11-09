import test from 'node:test';
import assert from 'node:assert/strict';
import { readProtectedApproval } from '../src/github-approval.mjs';
import { repositoryIssuePin } from '../src/repository-admission.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { now } from './approval-fixture.mjs';

test('native Scope and assignment admit new Issues under one repository policy',
  async () => {
    const f = approvalProviderFixture();
    const member = f.pr.merged_by;
    const policy = {
      kind: 'repository-admission-v1',
      repository: f.pin.repository,
      repositoryId: f.pin.repositoryId,
      memberId: member.id,
      protectionHash: f.pin.protectionHash,
      source: f.pin.source,
    };
    const issue = { ...f.record.issue, number: 42, id: 'I_new' };
    const pin = repositoryIssuePin(policy, issue);
    const live = {
      node_id: issue.id, number: issue.number, state: 'open', body: 'Scope',
      url: 'https://api.github.com/repos/example/core/issues/42',
      labels: [{ name: 'scope' }], assignees: [member],
    };
    f.reader.issue = async () => structuredClone(live);
    f.reader.blockedBy = async () => [];
    const timeline = [
      { event: 'labeled', label: { name: 'scope' }, actor: member },
      { event: 'assigned', assignee: member, actor: member },
    ];
    f.data['/issues/42/timeline'] = timeline;

    const first = await readProtectedApproval(f.reader, pin, now);
    assert.deepEqual(first.record.issue, issue);
    live.body = 'Published Shape';
    const second = await readProtectedApproval(f.reader, pin, now);
    assert.equal(second.record.scope.body, live.body);
    assert.deepEqual(evidenceBinding({ approval: first }),
      evidenceBinding({ approval: second }));

    timeline.at(-1).actor = { id: 8, login: 'reader', type: 'User' };
    f.data['/collaborators/reader/permission'] = {
      user: timeline.at(-1).actor, permission: 'read',
    };
    await assert.rejects(readProtectedApproval(f.reader, pin, now),
      /MEMBER_PERMISSION_REVOKED/);
    live.assignees = [];
    await assert.rejects(readProtectedApproval(f.reader, pin, now),
      /WAKE_TARGET_NOT_READY/);
  });
