import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { consumerContract } from '../src/public-api.mjs';

function command(...args) {
  const result = spawnSync(process.execPath, ['bin/nibfin-core.mjs', ...args],
    { encoding: 'utf8', input: '' });
  assert.ifError(result.error);
  return result;
}

test('completion contract is additive and discoverable in public help', () => {
  const contract = consumerContract.installedLifecycleCompletion;
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.command, 'complete-installed-lifecycle');
  assert.equal(contract.input, 'none');
  assert.deepEqual(contract.statuses, ['dispatched', 'paused', 'pending']);
  assert.deepEqual(contract.exitStatuses,
    { dispatched: 0, paused: 0, pending: 2, denied: 1 });
  assert.equal(consumerContract.managedPoolReplacement.activationCommand,
    'activate-shared-replacement');
  const help = command('help');
  assert.equal(help.status, 0, help.stderr);
  assert.deepEqual(JSON.parse(help.stdout).installedLifecycleCompletion, contract);
  assert.ok(JSON.parse(help.stdout).commands.some(value =>
    value.startsWith(contract.command)));
});

test('public completion refuses caller options and uninstalled source', () => {
  const options = ['--module', '--credential', '--state-root', '--repo', '--bypass'];
  for (const option of options) {
    const result = command('complete-installed-lifecycle', option);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr),
      { status: 'denied', code: 'INVALID_COMMAND' });
  }
  const result = command('complete-installed-lifecycle');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'denied',
    code: 'CONTINUATION_REQUIRES_INSTALLED_ADMINISTRATOR' });
});
