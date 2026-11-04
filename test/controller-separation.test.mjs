import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requirePlainAcl,
  requireRunnerGroups,
  verifyRunnerProcess,
} from '../src/controller-separation.mjs';

test('named socket or parent ACL grants cannot bypass group separation', () => {
  const plain = 'user::rw-\ngroup::rw-\nother::---\n';
  requirePlainAcl(plain);
  for (const extra of [
    'user:997:rw-\n',
    'group:987:rw-\n',
    'mask::rw-\n',
    'default:user::rwx\n',
  ]) {
    assert.throws(() => requirePlainAcl(plain + extra));
  }
  assert.throws(() => requirePlainAcl(''));
  assert.throws(() => requirePlainAcl(plain.replace('other::---', 'user::---')));
});

test('account and live process groups must exclude the Docker socket group', () => {
  requireRunnerGroups('987 1001\n', 986);
  for (const groups of ['987 986', '986', '', 'not-a-gid', '-1', '1.5']) {
    assert.throws(() => requireRunnerGroups(groups, 986));
  }
});

test('saved and filesystem process identities cannot conceal a socket group', () => {
  const status =
    'Uid:\t997\t997\t997\t997\n' + 'Gid:\t987\t987\t987\t987\nGroups:\t987 1001\n';
  verifyRunnerProcess(status, 997, 986);
  verifyRunnerProcess(status.replace('987 1001', ''), 997, 986);
  assert.throws(() => verifyRunnerProcess(status.replace('987 1001', '986'), 997, 986));
  assert.throws(() =>
    verifyRunnerProcess(status.replace('987\nGroups', '986\nGroups'), 997, 986),
  );
  assert.throws(() => verifyRunnerProcess(status.replace('Uid:', 'Unknown:'), 997, 986));
  const saved = status.replace('997\t997\t997\t997', '999\t999\t997\t999');
  assert.throws(() => verifyRunnerProcess(saved.replace('987 1001', '986'), 997, 986));
});
