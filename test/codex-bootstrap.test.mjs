import assert from 'node:assert/strict';
import test from 'node:test';
import { runCodex } from '../src/codex-bootstrap.mjs';

function runAgent(script) {
  return runCodex(['-e', script], {
    executable: process.execPath,
    cwd: process.cwd(),
    input: '',
    idleTimeout: 1000,
  });
}

test('tool progress extends the idle deadline across split JSON output', async () => {
  const result = await runAgent(`
    process.stdout.write('{"type":"item.');
    setTimeout(() => process.stdout.write('completed"}\\n'), 500);
    setTimeout(() => process.stdout.write('{"type":"turn.completed"}\\n'), 1200);
  `);
  assert.equal(result.stdout,
    '{"type":"item.completed"}\n{"type":"turn.completed"}\n');
});

test('stderr and non-progress JSON do not keep a stalled agent alive', async () => {
  await assert.rejects(runAgent(`
    setInterval(() => {
      process.stderr.write('waiting\\n');
      console.log(JSON.stringify({ type: 'heartbeat' }));
    }, 25);
  `), { message: 'CODEX_IDLE_TIMEOUT' });
});
