import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../src/process.mjs';

test('process adapter preserves argv without a shell and does not inherit credentials', async () => {
  const marker = 'NIBFIN_TEST_PRIVATE'; process.env[marker] = 'must-not-inherit';
  try {
    const result = await command(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.NIBFIN_TEST_PRIVATE??null}))', '$(echo unsafe);`cmd`']);
    assert.deepEqual(JSON.parse(result.stdout.toString()), { arg: '$(echo unsafe);`cmd`', secret: null });
  } finally { delete process.env[marker]; }
});

test('timeouts, excessive output and unavailable processes reject without leaking output', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 30 }), /PROCESS_TIMEOUT/);
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("sensitive".repeat(100))'], { limit: 10 }), /PROCESS_OUTPUT_LIMIT/);
  await assert.rejects(command('/nonexistent/nibfin-test', []), /PROCESS_UNAVAILABLE/);
  assert.throws(() => command('node', []), /INVALID_PROCESS_REQUEST/);
});
