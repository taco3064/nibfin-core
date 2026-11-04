import test from 'node:test';
import assert from 'node:assert/strict';
import { relayControllerRequest } from '../src/host-relay.mjs';

test('lost privileged handoff responses stay Pending without retry', async () => {
  for (const fault of ['PROCESS_TIMEOUT', 'PROCESS_FAILED', 'invalid-json']) {
    let calls = 0;
    const result = await relayControllerRequest(
      { command: 'stage', stage: 'continue' },
      999,
      async () => {
        calls += 1;
        if (fault === 'invalid-json') return { stdout: Buffer.from('{') };
        throw Object.assign(new Error(fault), { code: fault });
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
  }
});

test('one fixed command receives stdin and its native result is preserved', async () => {
  const request = { command: 'dispatch-event', event: '{"issue":{}}' };
  const result = await relayControllerRequest(request, 999, async (exe, args, opts) => {
    assert.equal(exe, '/usr/bin/sudo');
    assert.deepEqual(args, [
      '-n',
      '-u',
      '#999',
      '--',
      '/opt/nibfin/core/bin/nibfin-controller',
    ]);
    assert.deepEqual(JSON.parse(opts.input), request);
    assert.deepEqual(Object.keys(opts.env).sort(), ['LANG', 'PATH']);
    return { stdout: Buffer.from('{"status":"scheduled","code":"READ_BACK"}') };
  });
  assert.equal(result.status, 'scheduled');
});
