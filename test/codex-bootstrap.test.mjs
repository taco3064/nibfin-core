import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { idleDiagnostic, runCodex } from '../src/codex-bootstrap.mjs';

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

test('idle diagnostics expose only the last allowlisted event and tool type', () => {
  const stalledAgent = `
    console.log(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'private-command' },
    }));
    setInterval(() => {}, 50);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runCodex } from './src/codex-bootstrap.mjs';
    await runCodex(['-e', ${JSON.stringify(stalledAgent)}], {
      executable: process.execPath,
      cwd: process.cwd(),
      input: '',
      idleTimeout: 1000,
    }).catch(() => {});
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(idleDiagnostic(result.stderr),
    'NIBFIN_IDLE_PROGRESS item.started command_execution');
  assert.doesNotMatch(result.stderr, /private-command/);
  assert.equal(idleDiagnostic('NIBFIN_IDLE_PROGRESS item.started private'), undefined);
});
