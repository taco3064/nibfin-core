import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../src/process.mjs';

test('argv stays literal and credentials are not inherited', async () => {
  const marker = 'NIBFIN_TEST_PRIVATE';
  process.env[marker] = 'must-not-inherit';
  try {
    const result = await command(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({arg:process.argv[1],' +
        'secret:process.env.NIBFIN_TEST_PRIVATE??null}))',
      '$(echo unsafe);`cmd`',
    ]);
    assert.deepEqual(JSON.parse(result.stdout.toString()), {
      arg: '$(echo unsafe);`cmd`',
      secret: null,
    });
  } finally {
    delete process.env[marker];
  }
});

test('timeouts, output overflow and missing processes reject', async () => {
  await assert.rejects(
    command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 30 }),
    /PROCESS_TIMEOUT/,
  );
  await assert.rejects(
    command(process.execPath, ['-e', 'process.stdout.write("sensitive".repeat(100))'], {
      limit: 10,
    }),
    /PROCESS_OUTPUT_LIMIT/,
  );
  await assert.rejects(command('/nonexistent/nibfin-test', []), /PROCESS_UNAVAILABLE/);
  assert.throws(() => command('node', []), /INVALID_PROCESS_REQUEST/);
});

test('only whitelisted exits expose completed output', async () => {
  const args = ['-e', 'process.stdout.write("bounded"); process.exit(2)'];
  await assert.rejects(command(process.execPath, args), { code: 'PROCESS_FAILED' });
  const result = await command(process.execPath, args, { allowedExitCodes: [0, 1, 2] });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.toString(), 'bounded');
  for (const allowedExitCodes of [[], [null], [NaN], [-1], [256], ['0']]) {
    assert.throws(
      () => command(process.execPath, [], { allowedExitCodes }),
      /INVALID_PROCESS_REQUEST/,
    );
  }
});
