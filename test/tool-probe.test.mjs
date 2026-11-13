import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { versionProbe } from '../src/tool-recipe.mjs';
import { projectToolPath } from '../src/tool-catalog.mjs';

const tools = { node: '22.15.0', python: '3.13.7', go: '1.27.1' };
const versions = { node: '24.22.1', codex: 'codex-cli 0.166.0' };

function executeProbe(unavailable) {
  const calls = [];
  let output = '';
  const execFileSync = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === unavailable) throw new Error('executable unavailable');
    if (unavailable === 'python-runtime' && file === 'python3' && args[0] === '-c')
      throw new Error('runtime library unavailable');
    if (file === '/usr/local/bin/node') return `v${versions.node}\n`;
    if (file === '/usr/local/bin/codex') return `${versions.codex}\n`;
    if (file === 'node') return `v${tools.node}\n`;
    if (file === 'python3' && args[0] === '--version')
      return `Python ${tools.python}\n`;
    if (file === 'go') return `go${tools.go}\n`;
    return '';
  };
  runInNewContext(versionProbe(tools, versions), {
    require: name => {
      assert.equal(name, 'node:child_process');
      return { execFileSync };
    },
    process: { stdout: { write: value => { output += value; } } },
  });
  return { calls, output };
}

test('preparation rejects missing companion executables before success', () => {
  for (const file of ['npm', 'npx', 'pip', 'pip3', 'gofmt'])
    assert.throws(() => executeProbe(file), /executable unavailable/);
});

test('preparation exercises Python modules and bounds every subprocess', () => {
  assert.throws(() => executeProbe('python-runtime'), /runtime library unavailable/);
  const { calls, output } = executeProbe();
  assert.equal(output, 'NIBFIN_TOOLS_VERIFIED\n');
  const python = calls.find(call => call.file === 'python3' && call.args[0] === '-c');
  assert.ok(python, 'Python runtime libraries must be loaded before success');
  for (const module of ['ssl', 'sqlite3', 'bz2', 'lzma', 'ctypes'])
    assert.ok(python.args[1].includes(module));
  for (const { file, options } of calls) {
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(options.env.PATH, file.startsWith('/')
      ? '/usr/local/bin:/usr/bin:/bin' : projectToolPath);
    assert.equal(options.env.GOTOOLCHAIN, 'local');
  }
});
