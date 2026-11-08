import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovalRecord, bindRawScope } from '../src/approval-record.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';

test('approval binds Scope history, roles, source and dependencies', () => {
  const record = approvalRecord();
  assert.equal(validateApprovalRecord(record, now), record);
  assert.deepEqual(
    bindRawScope(record, {
      node_id: 'I_target',
      number: 2,
      url: 'https://api.github.com/repos/example/core/issues/2',
      state: 'open',
      body: record.scope.body,
    }),
    { issueId: 'I_target', scopeHash: record.scope.hash },
  );
});

test('altered, perpetual, invalid-role and extensible records reject', () => {
  const mutations = [
    (r) => {
      r.scope.body += 'More work';
    },
    (r) => {
      r.scope.hash = '0'.repeat(64);
    },
    (r) => {
      r.expiresAt = null;
    },
    (r) => {
      r.validFrom = r.expiresAt;
    },
    (r) => {
      r.roles.validator = 0;
    },
    (r) => {
      r.roles.acceptor = '1';
    },
    (r) => {
      r.roles.publisher = null;
    },
    (r) => {
      r.operations.push('admin');
    },
    (r) => {
      r.operations.push(r.operations[0]);
    },
    (r) => {
      r.authorized = true;
    },
    (r) => {
      r.prerequisites.push(r.issue);
    },
    (r) => {
      r.source.commit = 'main';
    },
    (r) => {
      r.issue.repositoryId = '10';
    },
    (r) => {
      r.issue.id = '';
    },
  ];
  for (const mutate of mutations) {
    const record = approvalRecord();
    mutate(record);
    assert.throws(() => validateApprovalRecord(record, now));
  }
  assert.throws(() =>
    validateApprovalRecord(approvalRecord(), Date.parse('2026-11-04T00:00:00Z')),
  );
});

test('current Issue text is accepted only for the bound Issue', () => {
  const r = approvalRecord();
  const remote = {
    node_id: 'I_target',
    number: 2,
    url: 'https://api.github.com/repos/example/core/issues/2',
    state: 'open',
    body: r.scope.body,
  };
  const edited = { ...remote, body: 'Current authorized requirements' };
  assert.notEqual(bindRawScope(r, edited).scopeHash, r.scope.hash);
  for (const change of [
    { body: ' ' },
    { node_id: 'I_other' },
    { number: 3 },
    { state: 'closed' },
    { pull_request: {} },
    { url: 'https://api.github.com/repos/foreign/core/issues/2' },
  ]) {
    assert.throws(() => bindRawScope(r, { ...remote, ...change }));
  }
});

test('one member may own independent execution roles', () => {
  const record = approvalRecord();
  for (const role of Object.keys(record.roles)) record.roles[role] = 1;
  assert.equal(validateApprovalRecord(record, now), record);
});
